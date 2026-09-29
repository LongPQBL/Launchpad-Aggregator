import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, toEventSelector, type Address, type Hash } from 'viem';
import type { Launch, Venue } from '../../../domain/types.js';
import type { RpcLog } from '../v1/adapter.js';
import { derivePonsV4PoolId, verifyPonsV4PoolInitialization, transitionOfficialVenue } from './poolKey.js';
import { decodePonsV4Swap, verifyPonsV4Graduation } from './v4Swaps.js';
import { v4SwapEvent } from './v4Swaps.js';
import { decodeCurveTrade } from './adapter.js';
import { buildOfficialCandles, sumOfficialQuoteVolume } from '../../../market/aggregate.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address, topics: raw.topics as Hash[], data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number), blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash, logIndex: Number(raw.logIndex),
  };
}

const launch: Launch = {
  chainId: 4663, tokenAddress: fixture.tokenAddress as Address, name: 'Graduated sample', symbol: 'SAMPLE', tokenDecimals: 18,
  platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'sample-launch-log',
  factoryAddress: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  deployerAddress: '0xCCE4F7805B3A5f03fE3ec7f02231d08B03cc35d2', launchBlock: 27_000_000n,
  launchTxHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
  quoteAsset: { address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 }, lifecycleStatus: 'graduated',
};
const curveVenue: Venue = {
  id: `4663:curve:${(fixture.curveAddress as string).toLowerCase()}`, chainId: 4663, tokenAddress: launch.tokenAddress,
  kind: 'curve', ref: fixture.curveAddress as string, sourceId: 'pons-v2', sourceLogId: launch.sourceLogId,
  effectiveFromBlock: launch.launchBlock, effectiveToBlock: null, official: true,
};
const terms = { fee: fixture.poolFee as number, tickSpacing: fixture.tickSpacing as number };
const poolId = fixture.poolId as Hash;

describe('pons v2 official V4 pool', () => {
  it('derives the known pool ID with sorted currencies, fee, tick spacing and hook', () => {
    expect(derivePonsV4PoolId(launch, terms, fixture.hookAddress as Address)).toBe(poolId);
    expect(derivePonsV4PoolId(launch, { ...terms, tickSpacing: 100 }, fixture.hookAddress as Address)).not.toBe(poolId);
    expect(derivePonsV4PoolId(launch, terms, '0x0000000000000000000000000000000000000001')).not.toBe(poolId);
  });

  it('matches factory graduation to PoolManager initialization in the same transaction', () => {
    const graduation = asLog(fixture.graduation as Record<string, unknown>);
    const initialization = asLog(fixture.initialize as Record<string, unknown>);
    expect(verifyPonsV4Graduation(graduation, launch)).toBe(true);
    expect(verifyPonsV4PoolInitialization(initialization, graduation, launch, terms, fixture.hookAddress as Address, fixture.poolManagerAddress as Address)).toBe(true);
  });

  it('closes the curve and opens exactly the derived V4 venue on phase 2', () => {
    const transition = transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log');
    expect(transition.closedCurve?.effectiveToBlock).toBe(27_828_161n);
    expect(transition.openedPool?.kind).toBe('v4_pool');
    expect(transition.openedPool?.ref).toBe(poolId);
    expect(transition.openedPool?.effectiveFromBlock).toBe(27_828_161n);
    expect(transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log')).toEqual(transition);
  });

  it('does not invent a V4 venue in swept or rescued phases', () => {
    expect(transitionOfficialVenue(launch, curveVenue, 1, 27_828_161n).openedPool).toBeNull();
    expect(transitionOfficialVenue(launch, curveVenue, 3, 27_828_161n).openedPool).toBeNull();
  });

  it('decodes a real V4 swap only for the official pool ID', () => {
    const transition = transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log');
    const venue = transition.openedPool!;
    const swap = asLog(fixture.swap as Record<string, unknown>);
    const trade = decodePonsV4Swap(swap, poolId, launch, venue, 1_700_000_000, fixture.poolManagerAddress as Address, fixture.hookAddress as Address);
    expect(trade?.side).toBe('sell');
    expect(trade?.quoteAmountRaw).toBe(5_620_497_268_881_825_819n);
    expect(trade?.tokenAmountRaw).toBe(31_880_381_102_749_799_957_318_148n);
    expect(trade?.venueId).toBe(venue.id);
    expect(decodePonsV4Swap({ ...swap, topics: [swap.topics[0], '0x' + '11'.repeat(32) as Hash, ...swap.topics.slice(2)] }, poolId, launch, venue, 1_700_000_000, fixture.poolManagerAddress as Address, fixture.hookAddress as Address)).toBeNull();
  });

  it('keeps a hook-initiated fee conversion as a protocol trade in pool volume', () => {
    const venue = transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log').openedPool!;
    const realSwap = asLog(fixture.swap as Record<string, unknown>);
    const hookSwap: RpcLog = {
      ...realSwap,
      topics: encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: poolId, sender: fixture.hookAddress as Address } }) as Hash[],
    };
    const trade = decodePonsV4Swap(hookSwap, poolId, launch, venue, 1_700_000_000, fixture.poolManagerAddress as Address, fixture.hookAddress as Address);
    expect(trade?.activityKind).toBe('protocol_fee_conversion');
    expect(trade?.side).toBe('sell');
    expect(trade?.quoteAmountRaw).toBe(5_620_497_268_881_825_819n);
  });

  it('counts a hook fee-conversion swap and a hook buyback separately when both really execute', () => {
    const venue = transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log').openedPool!;
    const sixDecimalLaunch = { ...launch, quoteAsset: { address: launch.quoteAsset.address, symbol: 'USDG', decimals: 6 } };
    const swap = asLog(fixture.swap as Record<string, unknown>);
    const topics = encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: poolId, sender: fixture.hookAddress as Address } }) as Hash[];
    const sqrtPriceX96 = 2n ** 96n;
    const buyback: RpcLog = { ...swap, logIndex: 108, topics,
      data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
        [1n, -1n, sqrtPriceX96, 1n, 0, 0]) };
    const conversion: RpcLog = { ...buyback, logIndex: 109,
      data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
        [-2n, 2n, sqrtPriceX96, 1n, 0, 0]) };
    const trades = [buyback, conversion].map((log) => decodePonsV4Swap(log, poolId, sixDecimalLaunch, venue, 1_700_000_000,
      fixture.poolManagerAddress as Address, fixture.hookAddress as Address)!);
    expect(trades.map((trade) => trade.activityKind)).toEqual(['protocol_buyback', 'protocol_fee_conversion']);
    expect(trades.map((trade) => trade.side)).toEqual(['buy', 'sell']);
    const market = { chainId: 4663, tokenAddress: launch.tokenAddress, quoteAssetAddress: launch.quoteAsset.address,
      venueIds: new Set([venue.id]), complete: true };
    expect(sumOfficialQuoteVolume(trades, 0, market).amountRaw).toBe(3n);
    const candle = buildOfficialCandles(trades, 60, market)[0];
    expect(candle.quoteVolumeRaw).toBe(3n);
    expect(candle.close).toBe('1000000000000');
    const sweepNotice: RpcLog = { ...conversion, address: fixture.hookAddress as Address, logIndex: 110,
      topics: [toEventSelector(parseAbiItem('event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)'))] };
    expect(decodePonsV4Swap(sweepNotice, poolId, sixDecimalLaunch, venue, 1_700_000_000,
      fixture.poolManagerAddress as Address, fixture.hookAddress as Address)).toBeNull();
  });

  it('connects a real pre-graduation curve buy to a later official V4 swap', () => {
    const curveBuy = decodeCurveTrade(asLog(fixture.curveBuy as Record<string, unknown>), launch, curveVenue, 1_700_000_000);
    const poolVenue = transitionOfficialVenue(launch, curveVenue, 2, 27_828_161n, poolId, 'graduation-log').openedPool!;
    const v4Swap = decodePonsV4Swap(asLog(fixture.swap as Record<string, unknown>), poolId, launch, poolVenue,
      1_700_000_100, fixture.poolManagerAddress as Address, fixture.hookAddress as Address);
    expect(curveBuy.tokenAddress).toBe(v4Swap?.tokenAddress);
    expect(curveBuy.quoteAssetAddress).toBe(v4Swap?.quoteAssetAddress);
    expect(curveBuy.venueId).not.toBe(v4Swap?.venueId);
    expect(curveBuy.blockNumber).toBeLessThan(27_828_161n);
    expect(v4Swap?.blockNumber).toBeGreaterThan(27_828_161n);
  });
});
