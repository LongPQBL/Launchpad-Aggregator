import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Address, type Hash } from 'viem';
import { getPonsFactorySources } from '../sourceRegistry.js';
import { createRobinhoodPublicClient } from '../../../chains/robinhood.js';
import type { RpcLog } from '../v1/adapter.js';
import { decodeV2Launch, hydrateV2Launch, decodeCurveTrade, decodeCurveBuyback, decodeV2CurveBatch, decodeV2FactoryBatch, resolveV2QuoteAsset, phaseToLifecycle, readV2LaunchRecord, readV2Phase, readV2TokenMetadata, type V2LaunchRecord, type V2ReadClient } from './adapter.js';
import { replayCurveEvent, replayCurveBuyback, rewindCurveEvent, rewindCurveBuyback } from './curve.js';
import { buildOfficialCandles, sumOfficialQuoteVolume } from '../../../market/aggregate.js';

const sourceFixtures = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-launches.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-v2-reference.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const buybackFixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/pons-v2-buyback.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const factory = getPonsFactorySources()[2];
const trader = '0x1234567890123456789012345678901234567890' as Address;

function asLog(raw: Record<string, unknown>): RpcLog {
  return {
    address: raw.address as Address,
    topics: raw.topics as Hash[],
    data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number | string),
    blockHash: raw.blockHash as Hash,
    transactionHash: (raw.transactionHash ?? raw.txHash) as Hash,
    logIndex: Number(raw.logIndex),
  };
}

const launchLog = asLog(sourceFixtures[2]);
const record: V2LaunchRecord = {
  token: reference.tokenAddress as Address,
  curve: reference.curveAddress as Address,
  deployer: '0x495c5f25cb41419d504e598801ef078fd9d0480b',
  pairToken: reference.quoteAddress as Address,
  poolFee: 0,
  tickSpacing: 200,
  phase: 0,
  exists: true,
};
const metadata = { name: reference.tokenName as string, symbol: reference.tokenSymbol as string, decimals: 18 };
const quote = { address: reference.quoteAddress as Address, symbol: 'NVDA', decimals: 18 };

describe('pons v2 launch and phase', () => {
  it('decodes a real factory launch and checks its canonical curve record', () => {
    const event = decodeV2Launch(launchLog, factory);
    const { launch, venue } = hydrateV2Launch(event, factory, record, metadata, quote);
    expect(event.curveAddress).toBe(reference.curveAddress);
    expect(launch.protocolVersion).toBe('v2');
    expect(launch.quoteAsset.address).toBe(reference.quoteAddress);
    expect(venue.kind).toBe('curve');
    expect(venue.ref).toBe(reference.curveAddress);
  });

  it('rejects a copied token address without the canonical factory log', () => {
    expect(() => decodeV2Launch({ ...launchLog, address: record.curve }, factory)).toThrow(/factory/i);
  });

  it('keeps the launch at its historical trading phase even when the current factory phase is later', () => {
    const event = decodeV2Launch(launchLog, factory);
    const swept = hydrateV2Launch(event, factory, { ...record, phase: 1 }, metadata, quote);
    const rescued = hydrateV2Launch(event, factory, { ...record, phase: 3 }, metadata, quote);
    const graduated = hydrateV2Launch(event, factory, { ...record, phase: 2 }, metadata, quote);
    expect(swept.launch.lifecycleStatus).toBe('trading');
    expect(swept.venue.kind).toBe('curve');
    expect(rescued.launch.lifecycleStatus).toBe('trading');
    expect(graduated.launch.lifecycleStatus).toBe('trading');
    expect(phaseToLifecycle(2)).toBe('graduated');
  });

  it('carries extended metadata and launch timestamp through onto the Launch object when provided', () => {
    const event = decodeV2Launch(launchLog, factory);
    const extended = { logoUri: 'ipfs://bafkreitest', description: 'A real token', websiteUrl: 'https://example.com', twitterUrl: 'https://x.com/example' };
    const { launch } = hydrateV2Launch(event, factory, record, metadata, quote, { ...extended, launchTimestamp: 1_700_000_000 });
    expect(launch.logoUri).toBe('ipfs://bafkreitest');
    expect(launch.description).toBe('A real token');
    expect(launch.websiteUrl).toBe('https://example.com');
    expect(launch.twitterUrl).toBe('https://x.com/example');
    expect(launch.launchTimestamp).toBe(1_700_000_000);
  });

  it('defaults extended metadata and launch timestamp to null when the 6th argument is omitted', () => {
    const event = decodeV2Launch(launchLog, factory);
    const { launch } = hydrateV2Launch(event, factory, record, metadata, quote);
    expect(launch.logoUri).toBeNull();
    expect(launch.description).toBeNull();
    expect(launch.websiteUrl).toBeNull();
    expect(launch.twitterUrl).toBeNull();
    expect(launch.launchTimestamp).toBeNull();
  });

  it('reads a six-decimal ERC-20 quote asset instead of assuming ETH units', async () => {
    const pairToken = '0x0000000000000000000000000000000000000002' as Address;
    const asset = await resolveV2QuoteAsset(pairToken, { readContract: async ({ functionName }: { functionName: string }) => functionName === 'symbol' ? 'USDC' : 6 });
    expect(asset).toEqual({ address: pairToken, symbol: 'USDC', decimals: 6 });
  });

  it('represents a native quote asset as ETH without a contract read', async () => {
    const asset = await resolveV2QuoteAsset('0x0000000000000000000000000000000000000000', {
      readContract: async () => { throw new Error('Native ETH has no ERC-20 contract'); },
    });
    expect(asset).toEqual({ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 });
  });

  it('reads launch token metadata from the token contract', async () => {
    const client = { readContract: async ({ functionName }: { functionName: string }) => ({ name: reference.tokenName, symbol: reference.tokenSymbol, decimals: 18 })[functionName] };
    expect(await readV2TokenMetadata(client, record.token)).toEqual(metadata);
  });

  it('accepts the actual Robinhood viem client for factory state reads', () => {
    const client: V2ReadClient = createRobinhoodPublicClient('https://rpc.mainnet.chain.robinhood.com');
    expect(client.readContract).toBeTypeOf('function');
  });

  it('reads the factory record and authoritative phase at a requested block', async () => {
    const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = { readContract: async (parameters: { functionName: string; blockNumber?: bigint }) => {
      calls.push(parameters);
      return { ...record, phase: 1 };
    } };
    const fetched = await readV2LaunchRecord(client, factory.factory, record.token, 27027321n);
    expect(fetched.curve.toLowerCase()).toBe(record.curve.toLowerCase());
    expect(fetched.poolFee).toBe(0);
    expect(fetched.tickSpacing).toBe(200);
    expect(await readV2Phase(client, factory.factory, record.token, 27027321n)).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.functionName === 'getLaunchedToken' && call.blockNumber === 27027321n)).toBe(true);
  });

  it('emits the real launch, curve and raw-log provenance as one batch', async () => {
    const batch = await decodeV2FactoryBatch([launchLog], factory, async () => ({ record, metadata, quoteAsset: quote }));
    expect(batch.launches).toHaveLength(1);
    expect(batch.venues).toHaveLength(1);
    expect(batch.rawLogs).toHaveLength(1);
    expect(batch.launches[0].sourceLogId).toBe(batch.venues[0].sourceLogId);
    expect(batch.rawLogs[0].sourceId).toBe('pons-v2');
  });

  it('loads per-launch metadata concurrently instead of one round trip at a time', async () => {
    const hashes = [1, 2, 3].map((index) => `0x${index.toString().repeat(64)}`.slice(0, 66) as Hash);
    const logs: RpcLog[] = hashes.map((transactionHash) => ({ ...launchLog, transactionHash }));
    const requestedHashes: Hash[] = [];
    const releases: Array<(value: { record: V2LaunchRecord; metadata: typeof metadata; quoteAsset: typeof quote }) => void> = [];
    const loadState = (event: { transactionHash: Hash }) => {
      requestedHashes.push(event.transactionHash);
      return new Promise<{ record: V2LaunchRecord; metadata: typeof metadata; quoteAsset: typeof quote }>((resolve) => {
        releases.push(resolve);
      });
    };
    const resultPromise = decodeV2FactoryBatch(logs, factory, loadState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedHashes).toEqual(hashes);
    for (const release of releases) release({ record, metadata, quoteAsset: quote });
    const batch = await resultPromise;
    expect(batch.launches).toHaveLength(3);
  });
});

describe('pons v2 curve trades', () => {
  const context = () => hydrateV2Launch(decodeV2Launch(launchLog, factory), factory, record, metadata, quote);

  it('decodes the real curve buyback as a protocol buy with the actual USDG quote amount', () => {
    const { launch, venue } = context();
    launch.tokenAddress = buybackFixture.tokenAddress as Address;
    launch.quoteAsset = { address: buybackFixture.quoteAddress as Address, symbol: 'USDG', decimals: 6 };
    venue.tokenAddress = launch.tokenAddress;
    venue.ref = buybackFixture.curveAddress as string;
    const buyback = decodeCurveBuyback(asLog(buybackFixture.buyback as Record<string, unknown>), launch, venue, 1_700_000_000, trader);
    expect(buyback.activityKind).toBe('protocol_buyback');
    expect(buyback.sourceEvent).toBe('BuybackLocked');
    expect(buyback.side).toBe('buy');
    expect(buyback.quoteAmountRaw).toBe(22_028_506n);
    expect(buyback.tokenAmountRaw).toBe(4_800_278_083_646_296_645_657_066n);
    expect(buyback.traderAddress).toBe(trader.toLowerCase());
  });

  it('counts the buyback once even when the same transaction sweeps fees and locks tokens', async () => {
    const { launch, venue } = context();
    launch.tokenAddress = buybackFixture.tokenAddress as Address;
    launch.quoteAsset = { address: buybackFixture.quoteAddress as Address, symbol: 'USDG', decimals: 6 };
    venue.tokenAddress = launch.tokenAddress;
    venue.ref = buybackFixture.curveAddress as string;
    const buybackLog = asLog(buybackFixture.buyback as Record<string, unknown>);
    const feesSweptLog = asLog(buybackFixture.feesSwept as Record<string, unknown>);
    const batch = await decodeV2CurveBatch(
      [buybackLog, feesSweptLog],
      'pons-v2-curve-cohort', new Map([[venue.ref.toLowerCase(), { launch, venue }]]),
      async () => new Map([[buybackLog.blockNumber, { timestamp: 1_700_000_000,
        traders: new Map([[buybackLog.transactionHash, trader], [feesSweptLog.transactionHash, trader]]) }]]),
    );
    expect(batch.trades).toHaveLength(1);
    expect(batch.trades[0].activityKind).toBe('protocol_buyback');
    expect(sumOfficialQuoteVolume(batch.trades, 0, { chainId: 4663, tokenAddress: launch.tokenAddress,
      quoteAssetAddress: launch.quoteAsset.address, venueIds: new Set([venue.id]), complete: true }).amountRaw).toBe(22_028_506n);
    expect((buybackFixture.vaultLock as Record<string, unknown>).address).not.toBe(venue.ref);
  });

  it('uses verified post-buyback reserves for a six-decimal quote chart point', () => {
    const { launch, venue } = context();
    launch.tokenAddress = buybackFixture.tokenAddress as Address;
    launch.quoteAsset = { address: buybackFixture.quoteAddress as Address, symbol: 'USDG', decimals: 6 };
    venue.tokenAddress = launch.tokenAddress;
    venue.ref = buybackFixture.curveAddress as string;
    const buyback = decodeCurveBuyback(asLog(buybackFixture.buyback as Record<string, unknown>), launch, venue, 1_700_000_000, trader,
      { quote: 100_000_000n, token: 10_000_000n * 10n ** 18n });
    const candle = buildOfficialCandles([buyback], 60, { chainId: 4663, tokenAddress: launch.tokenAddress,
      quoteAssetAddress: launch.quoteAsset.address, venueIds: new Set([venue.id]), complete: true })[0];
    expect(candle.close).toBe('0.00001');
    expect(candle.quoteVolumeRaw).toBe(22_028_506n);
  });

  it('uses actual filled amounts from real buy and sell events', () => {
    const { launch, venue } = context();
    const buy = decodeCurveTrade(asLog(reference.buy as Record<string, unknown>), launch, venue, 1_700_000_000, trader);
    const sell = decodeCurveTrade(asLog(reference.sell as Record<string, unknown>), launch, venue, 1_700_000_010, trader);
    expect(buy.side).toBe('buy');
    expect(buy.quoteAmountRaw).toBe(28_716_771_876_358_226n);
    expect(buy.tokenAmountRaw).toBeGreaterThan(0n);
    expect(sell.side).toBe('sell');
    expect(sell.tokenAmountRaw).toBeGreaterThan(0n);
    expect(sell.quoteAmountRaw).toBeGreaterThan(0n);
    expect(buy.priceNumeratorRaw).toBeNull();
    expect(buy.traderAddress).toBe(trader.toLowerCase());
  });

  it('counts a filled buy once and excludes other curve logs from volume', async () => {
    const { launch, venue } = context();
    const buyLog = asLog(reference.buy as Record<string, unknown>);
    const otherLog: RpcLog = {
      ...buyLog,
      logIndex: buyLog.logIndex + 1,
      topics: ['0x9f4cd7c4ed99d08a797804560c9c5d71d2cf7e101f2e3b5e7d1ca8a24c370e4f'],
      data: '0x',
    };
    const batch = await decodeV2CurveBatch([buyLog, otherLog], 'pons-v2-curve-cohort', new Map([[venue.ref.toLowerCase(), { launch, venue }]]),
      async () => new Map([[buyLog.blockNumber, { timestamp: 1_700_000_000, traders: new Map([[buyLog.transactionHash, trader]]) }]]));
    expect(batch.trades).toHaveLength(1);
    expect(batch.trades[0].quoteAmountRaw).toBe(28_716_771_876_358_226n);
    expect(batch.rawLogs).toHaveLength(2);
  });

  it('fetches all distinct blocks in a single batch call instead of one round trip per block', async () => {
    const { launch, venue } = context();
    const buyLog = asLog(reference.buy as Record<string, unknown>);
    const sellLog = { ...asLog(reference.sell as Record<string, unknown>), blockNumber: buyLog.blockNumber + 1n };
    const calls: bigint[][] = [];
    const getBlocksData = async (blockNumbers: readonly bigint[]) => {
      calls.push([...blockNumbers]);
      return new Map(blockNumbers.map((blockNumber) => {
        const log = blockNumber === buyLog.blockNumber ? buyLog : sellLog;
        return [blockNumber, { timestamp: 1_700_000_000, traders: new Map([[log.transactionHash, trader]]) }] as const;
      }));
    };
    const batch = await decodeV2CurveBatch([buyLog, sellLog], 'pons-v2-curve-cohort',
      new Map([[venue.ref.toLowerCase(), { launch, venue }]]), getBlocksData);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(batch.trades).toHaveLength(2);
    expect(batch.trades.every((t) => t.traderAddress === trader.toLowerCase())).toBe(true);
  });

  it('uses post-trade reserves for price and scales by quote decimals', () => {
    const { launch, venue } = context();
    launch.quoteAsset = { address: launch.quoteAsset.address, symbol: 'USDC', decimals: 6 };
    const buy = decodeCurveTrade(asLog(reference.buy as Record<string, unknown>), launch, venue, 1_700_000_000, trader, { quote: 2_000_000n, token: 10n ** 18n });
    expect(buy.priceNumeratorRaw).toBe(2_000_000n * 10n ** 18n);
    expect(buy.priceDenominatorRaw).toBe(10n ** 18n * 10n ** 6n);
  });

  it('replays net reserves after fees rather than gross buyer spend', () => {
    const next = replayCurveEvent({ quote: 1_000n, token: 10_000n }, { side: 'buy', quoteAmountRaw: 100n, tokenAmountRaw: 500n, feeRaw: 3n, taxRaw: 2n });
    expect(next).toEqual({ quote: 1_095n, token: 9_500n });
  });

  it('subtracts gross quote output and fees after a sell', () => {
    const next = replayCurveEvent({ quote: 1_000n, token: 10_000n }, { side: 'sell', quoteAmountRaw: 90n, tokenAmountRaw: 500n, feeRaw: 5n, taxRaw: 5n });
    expect(next).toEqual({ quote: 900n, token: 10_500n });
  });

  it('reconstructs opening reserves across trades and an internal buyback', () => {
    const opening = { quote: 1_000n, token: 10_000n };
    const buy = { side: 'buy' as const, quoteAmountRaw: 100n, tokenAmountRaw: 500n, feeRaw: 3n, taxRaw: 2n };
    const sell = { side: 'sell' as const, quoteAmountRaw: 90n, tokenAmountRaw: 500n, feeRaw: 5n, taxRaw: 5n };
    const afterBuy = replayCurveEvent(opening, buy);
    const afterBuyback = replayCurveBuyback(afterBuy, { quoteSpentRaw: 10n, tokensLockedRaw: 80n });
    const current = replayCurveEvent(afterBuyback, sell);
    expect(afterBuyback).toEqual({ quote: 1_105n, token: 9_420n });
    expect(current).toEqual({ quote: 1_005n, token: 9_920n });
    const beforeSell = rewindCurveEvent(current, sell);
    const beforeBuyback = rewindCurveBuyback(beforeSell, { quoteSpentRaw: 10n, tokensLockedRaw: 80n });
    expect(rewindCurveEvent(beforeBuyback, buy)).toEqual(opening);
  });
});
