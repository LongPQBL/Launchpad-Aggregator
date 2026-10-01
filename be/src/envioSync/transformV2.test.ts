import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address, type Hash } from 'viem';
import { decodeV2Launch } from '../launchpads/pons/v2/adapter.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { decodeCurveTrade } from '../launchpads/pons/v2/adapter.js';
import { envioRawLaunchV2ToEvent, hydrateV2LaunchFromEnvio, hydrateCurveTradeFromDecoded, hydrateCurveBuybackFromDecoded,
  resolveKnownQuoteAsset, type EnvioRawLaunchV2Row, type EnvioRawCurveTradeRow, type EnvioRawCurveBuybackRow } from './transformV2.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const v2Factory = getPonsFactorySources()[2];

interface RpcLogLike { address: Address; topics: readonly Hash[]; data: Hash; blockNumber: bigint; blockHash: Hash; transactionHash: Hash; logIndex: number }

function asLog(raw: Record<string, unknown>): RpcLogLike {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number),
    blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash,
    logIndex: Number(raw.logIndex),
  };
}

describe('envioRawLaunchV2ToEvent', () => {
  it('produces the same V2LaunchEvent as decoding the raw log directly', () => {
    const expected = decodeV2Launch(asLog(fixture.launch as Record<string, unknown>), v2Factory);
    const row: EnvioRawLaunchV2Row = {
      chainId: 4663,
      tokenAddress: fixture.tokenAddress as string,
      curveAddress: fixture.curveAddress as string,
      deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2',
      pairTokenAddress: fixture.quoteAddress as string,
      blockNumber: 27823666n,
      blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
      txHash: (fixture.launch as Record<string, unknown>).transactionHash as string,
      logIndex: 30,
    };
    const event = envioRawLaunchV2ToEvent(row);
    expect(event).toEqual(expected);
  });
});

describe('hydrateV2LaunchFromEnvio', () => {
  it('produces a Launch/Venue pair with the event as the sole source of truth (no RPC record needed)', () => {
    const row: EnvioRawLaunchV2Row = {
      chainId: 4663,
      tokenAddress: fixture.tokenAddress as string,
      curveAddress: fixture.curveAddress as string,
      deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2',
      pairTokenAddress: fixture.quoteAddress as string,
      blockNumber: 27823666n,
      blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
      txHash: (fixture.launch as Record<string, unknown>).transactionHash as string,
      logIndex: 30,
    };
    const event = envioRawLaunchV2ToEvent(row);
    const { launch, venue } = hydrateV2LaunchFromEnvio(event, v2Factory,
      { name: 'Real Name', symbol: 'REAL', decimals: 18 },
      { address: event.pairToken, symbol: 'USDG', decimals: 6 });
    expect(launch.tokenAddress).toBe(fixture.tokenAddress as string);
    expect(launch.protocolVersion).toBe('v2');
    expect(launch.quoteAsset.address).toBe(fixture.quoteAddress as string);
    expect(launch.name).toBe('Real Name');
    expect(launch.symbol).toBe('REAL');
    expect(launch.quoteAsset.symbol).toBe('USDG');
    expect(launch.quoteAsset.decimals).toBe(6);
    expect(launch.tokenDecimals).toBe(18);
    expect(venue.kind).toBe('curve');
    expect(venue.ref).toBe(fixture.curveAddress as string);
    expect(venue.official).toBe(true);
  });
});

const { launch, venue } = hydrateV2LaunchFromEnvio(
  envioRawLaunchV2ToEvent({
    chainId: 4663, tokenAddress: fixture.tokenAddress as string, curveAddress: fixture.curveAddress as string,
    deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2', pairTokenAddress: fixture.quoteAddress as string,
    blockNumber: 27823666n, blockHash: (fixture.launch as Record<string, unknown>).blockHash as string,
    txHash: (fixture.launch as Record<string, unknown>).transactionHash as string, logIndex: 30,
  }),
  v2Factory,
  { name: 'Fixture', symbol: 'FIX', decimals: 18 },
  { address: fixture.quoteAddress as Address, symbol: 'ETH', decimals: 18 },
);
const curveTrader = '0x1234567890123456789012345678901234567890' as Address;

describe('hydrateCurveTradeFromDecoded', () => {
  it('produces the same Trade as decoding the real fixture CurveBuy log directly', () => {
    const expected = decodeCurveTrade(asLog(fixture.curveBuy as Record<string, unknown>), launch, venue, 1_700_000_000, curveTrader);
    const row: EnvioRawCurveTradeRow = {
      curveAddress: fixture.curveAddress as string,
      side: 'buy',
      tokenAmountRaw: 20552501950319369479600566n,
      quoteAmountRaw: 352696917677647859n,
      feeRaw: 3526969176776478n,
      taxRaw: 0n,
      txFrom: curveTrader,
      blockNumber: 27823668n,
      blockHash: (fixture.curveBuy as Record<string, unknown>).blockHash as string,
      txHash: (fixture.curveBuy as Record<string, unknown>).transactionHash as string,
      logIndex: 19,
      timestamp: 1_700_000_000,
    };
    const trade = hydrateCurveTradeFromDecoded(row, venue, launch);
    expect(trade).toEqual(expected);
    expect(trade.side).toBe('buy');
    expect(trade.priceNumeratorRaw).toBeNull();
    expect(trade.priceDenominatorRaw).toBeNull();
  });

  it('maps a CurveSell row without swapping the token/quote legs', () => {
    const row: EnvioRawCurveTradeRow = {
      curveAddress: fixture.curveAddress as string,
      side: 'sell',
      tokenAmountRaw: 500_000_000_000_000_000_000n,
      quoteAmountRaw: 9_000_000_000_000_000n,
      feeRaw: 90_000_000_000_000n,
      taxRaw: 0n,
      txFrom: '0x1234567890123456789012345678901234567890',
      blockNumber: 27827000n,
      blockHash: '0x' + 'c'.repeat(64),
      txHash: '0x' + '7'.repeat(64),
      logIndex: 3,
      timestamp: 1_700_000_100,
    };
    const trade = hydrateCurveTradeFromDecoded(row, venue, launch);
    expect(trade.side).toBe('sell');
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(9_000_000_000_000_000n);
    expect(trade.sourceEvent).toBe('CurveSell');
  });
});

describe('hydrateCurveBuybackFromDecoded', () => {
  it('maps a BuybackLocked row to activityKind protocol_buyback, not user_trade', () => {
    const buybackTxFrom = '0x9999999999999999999999999999999999999999' as Address;
    const row: EnvioRawCurveBuybackRow = {
      curveAddress: fixture.curveAddress as string,
      quoteSpentRaw: 1_000_000_000_000_000_000n,
      tokensLockedRaw: 2_000_000_000_000_000_000n,
      txFrom: buybackTxFrom,
      blockNumber: 27827500n,
      blockHash: '0x' + 'd'.repeat(64),
      txHash: '0x' + '8'.repeat(64),
      logIndex: 7,
      timestamp: 1_700_000_200,
    };
    const trade = hydrateCurveBuybackFromDecoded(row, venue, launch);
    expect(trade.activityKind).toBe('protocol_buyback');
    expect(trade.side).toBe('buy');
    expect(trade.tokenAmountRaw).toBe(2_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
    // The trader is the transaction's tx.from (BuybackLocked has no buyer param at all) — not a
    // made-up value like the launch's factory address.
    expect(trade.traderAddress).toBe(buybackTxFrom);
    expect(trade.traderAddress).not.toBe(launch.factoryAddress);
  });
});

describe('resolveKnownQuoteAsset', () => {
  it('knows the zero address is native ETH, 18 decimals, without any RPC call', () => {
    expect(resolveKnownQuoteAsset(zeroAddress)).toEqual({ symbol: 'ETH', decimals: 18 });
  });

  it('returns null for any real ERC20 pair token — decimals are genuinely unknown without a metadata RPC call', () => {
    // Real V2 launches quote in tokens with decimals other than 18 (e.g. USDG has 6, cbBTC has 8) —
    // faking 18 here would silently corrupt any volume computed from staging for those launches.
    expect(resolveKnownQuoteAsset(fixture.quoteAddress as Address)).toBeNull();
  });
});
