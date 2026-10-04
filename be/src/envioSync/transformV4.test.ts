import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hash } from 'viem';
import type { Launch, Venue } from '../domain/types.js';
import { venueKey } from '../domain/ids.js';
import { decodePonsV4Swap, v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';
import { verifyV4PoolFromEnvio, openV4Venue, hydrateV4SwapFromDecoded, type EnvioRawV4InitializeRow, type EnvioRawV4SwapRow } from './transformV4.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const launch: Launch = {
  chainId: 4663, tokenAddress: fixture.tokenAddress as Address, name: null as unknown as string, symbol: null as unknown as string,
  tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'l2',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address, deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2' as Address,
  launchBlock: 27823666n, launchTxHash: (fixture.launch as Record<string, unknown>).transactionHash as `0x${string}`,
  quoteAsset: { address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 }, lifecycleStatus: 'graduated',
};
const curveVenue: Venue = {
  id: venueKey(4663, 'curve', fixture.curveAddress as string), chainId: 4663, tokenAddress: launch.tokenAddress,
  kind: 'curve', ref: fixture.curveAddress as string, sourceId: 'pons-v2', sourceLogId: 'l2',
  effectiveFromBlock: 27823666n, effectiveToBlock: 27823772n, official: true,
};
const graduatedTxHash = '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3';
const graduatedBlockHash = '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e';

function initializeRow(overrides: Partial<EnvioRawV4InitializeRow> = {}): EnvioRawV4InitializeRow {
  return {
    poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
    currency0: fixture.tokenAddress as string,
    currency1: fixture.quoteAddress as string,
    fee: 0, tickSpacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    txHash: graduatedTxHash, blockHash: graduatedBlockHash,
    blockNumber: 27828161n, logIndex: 16,
    ...overrides,
  };
}

describe('verifyV4PoolFromEnvio', () => {
  it('accepts the real fixture Initialize event matched to the real graduation tx', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch);
    expect(evidence).not.toBeNull();
    expect(evidence!.poolId).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
  });

  it('rejects an Initialize event from a different transaction (same block is not enough)', () => {
    const row = initializeRow({ txHash: '0x' + '7'.repeat(64) });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event whose currencies do not match the launch', () => {
    const row = initializeRow({ currency1: '0x1111111111111111111111111111111111111111' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });

  it('rejects an Initialize event using a hook other than the audited Pons hook', () => {
    const row = initializeRow({ hooks: '0x2222222222222222222222222222222222222222' });
    expect(verifyV4PoolFromEnvio(row, graduatedTxHash, graduatedBlockHash, launch)).toBeNull();
  });
});

describe('openV4Venue', () => {
  it('opens an official v4_pool venue at the graduation position', () => {
    const evidence = verifyV4PoolFromEnvio(initializeRow(), graduatedTxHash, graduatedBlockHash, launch)!;
    const venue = openV4Venue(launch, curveVenue, evidence, { blockNumber: 27828161n, logIndex: 36 });
    expect(venue.kind).toBe('v4_pool');
    expect(venue.ref).toBe('0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
    expect(venue.sourceId).toBe('pons-v2-v4:0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1');
    expect(venue.official).toBe(true);
    expect(venue.effectiveFromBlock).toBe(27828161n);
  });
});

describe('hydrateV4SwapFromDecoded', () => {
  const v4Venue: Venue = {
    id: venueKey(4663, 'v4_pool', '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1'),
    chainId: 4663, tokenAddress: launch.tokenAddress, kind: 'v4_pool',
    ref: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
    sourceId: 'pons-v2-v4', sourceLogId: 'v4-init-x', effectiveFromBlock: 27828161n, effectiveToBlock: null, official: true,
  };
  const poolManager = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
  const hook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address;

  it('produces the same Trade as decodePonsV4Swap for the real fixture swap (a sell)', () => {
    const swapLog = fixture.swap as Record<string, unknown>;
    const expected = decodePonsV4Swap(
      { address: swapLog.address as Address, topics: swapLog.topics as Hash[], data: swapLog.data as Hash,
        blockNumber: 27828165n, blockHash: swapLog.blockHash as Hash, transactionHash: swapLog.transactionHash as Hash, logIndex: 108 },
      '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1' as Hash,
      launch, v4Venue, 1_700_000_000, '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc' as Address, poolManager, hook,
    );
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      txFrom: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      amount0: -31880381102749799957318148n,
      amount1: 5620497268881825819n,
      sqrtPriceX96: 30937564032784793309170036n,
      blockNumber: 27828165n, blockHash: swapLog.blockHash as string, txHash: swapLog.transactionHash as string,
      logIndex: 108, timestamp: 1_700_000_000,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch, launch.quoteAsset.decimals);
    expect(trade).toEqual(expected);
    expect(trade!.side).toBe('sell');
    expect(trade!.activityKind).toBe('user_trade');
  });

  it('classifies a hook-initiated buyback swap as protocol_buyback, not user_trade', () => {
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: hook, txFrom: hook,
      amount0: 1_000_000_000_000_000_000n, amount1: -500_000_000_000_000_000n,
      sqrtPriceX96: 30937564032784793309170036n,
      blockNumber: 27829000n, blockHash: '0x' + 'f'.repeat(64), txHash: '0x' + '6'.repeat(64),
      logIndex: 2, timestamp: 1_700_000_500,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch, launch.quoteAsset.decimals);
    expect(trade).not.toBeNull();
    expect(trade!.activityKind).toBe('protocol_buyback');
  });

  it('classifies a hook-initiated fee-conversion swap as protocol_fee_conversion', () => {
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: hook, txFrom: hook,
      amount0: -1_000_000_000_000_000_000n, amount1: 500_000_000_000_000_000n,
      sqrtPriceX96: 30937564032784793309170036n,
      blockNumber: 27829001n, blockHash: '0x' + 'f'.repeat(64), txHash: '0x' + '7'.repeat(64),
      logIndex: 3, timestamp: 1_700_000_501,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch, launch.quoteAsset.decimals);
    expect(trade).not.toBeNull();
    expect(trade!.activityKind).toBe('protocol_fee_conversion');
  });

  it('returns null price fields (never fakes decimals) when the quote asset decimals are unknown', () => {
    const swapLog = fixture.swap as Record<string, unknown>;
    const row: EnvioRawV4SwapRow = {
      poolId: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      sender: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      txFrom: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
      amount0: -31880381102749799957318148n,
      amount1: 5620497268881825819n,
      sqrtPriceX96: 30937564032784793309170036n,
      blockNumber: 27828165n, blockHash: swapLog.blockHash as string, txHash: swapLog.transactionHash as string,
      logIndex: 108, timestamp: 1_700_000_000,
    };
    const trade = hydrateV4SwapFromDecoded(row, v4Venue, launch, null);
    expect(trade).not.toBeNull();
    expect(trade!.priceNumeratorRaw).toBeNull();
    expect(trade!.priceDenominatorRaw).toBeNull();
    expect(trade!.side).toBe('sell');
    expect(trade!.tokenAmountRaw).toBe(31880381102749799957318148n);
  });

  it('matches decodePonsV4Swap for a currency0-quote (reverse ordering) buy', () => {
    const reverseLaunch: Launch = {
      ...launch,
      tokenAddress: '0x9999999999999999999999999999999999999999' as Address,
      quoteAsset: { address: '0x1111111111111111111111111111111111111111' as Address, symbol: 'ETH', decimals: 18 },
    };
    const reversePoolId = ('0x' + 'd'.repeat(64)) as Hash;
    const reverseVenue: Venue = { ...v4Venue, tokenAddress: reverseLaunch.tokenAddress, ref: reversePoolId };
    const sender = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc' as Address;
    // currency0 = quote (0x1111...) < currency1 = token (0x9999...): a buy means the user pays quote
    // in (negative amount0) and receives token out (positive amount1).
    const amount0 = -1_000_000_000_000_000_000n;
    const amount1 = 2_000_000_000_000_000_000n;
    const sqrtPriceX96 = 30937564032784793309170036n;
    const liquidity = 92140088551983424601325n;
    const tick = -156971;
    const blockNumber = 27829002n;
    const blockHash = ('0x' + 'f'.repeat(64)) as Hash;
    const txHash = ('0x' + '8'.repeat(64)) as Hash;
    const logIndex = 4;
    const timestamp = 1_700_000_502;

    const topics = encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap', args: { id: reversePoolId, sender } });
    const data = encodeAbiParameters(
      v4SwapEvent.inputs.filter((input) => !('indexed' in input && input.indexed)),
      [amount0, amount1, sqrtPriceX96, liquidity, tick, 0],
    );
    const expected = decodePonsV4Swap(
      { address: poolManager, topics: topics as Hash[], data,
        blockNumber, blockHash, transactionHash: txHash, logIndex },
      reversePoolId, reverseLaunch, reverseVenue, timestamp, sender, poolManager, hook,
    );

    const row: EnvioRawV4SwapRow = {
      poolId: reversePoolId, sender, txFrom: sender, amount0, amount1, sqrtPriceX96,
      blockNumber, blockHash, txHash, logIndex, timestamp,
    };
    const trade = hydrateV4SwapFromDecoded(row, reverseVenue, reverseLaunch, reverseLaunch.quoteAsset.decimals);
    expect(trade).toEqual(expected);
    expect(trade!.side).toBe('buy');
    expect(trade!.tokenAmountRaw).toBe(2_000_000_000_000_000_000n);
    expect(trade!.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });
});
