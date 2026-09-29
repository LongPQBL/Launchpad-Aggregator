import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, type Address, type Hash, type Log } from 'viem';
import type { Launch, Venue } from '../domain/types.js';
import { scanToHead } from './scan.js';
import { v4SwapEvent } from '../launchpads/pons/v2/v4Swaps.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/pons-v2-graduated.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const swap = fixture.swap as Record<string, unknown>;
const poolId = fixture.poolId as Hash;
const poolManager = fixture.poolManagerAddress as Address;
const hook = fixture.hookAddress as Address;
const trader = '0x1234567890123456789012345678901234567890' as Address;

function asLog(raw: Record<string, unknown>): Log {
  return { address: raw.address as Address, topics: raw.topics as Hash[], data: raw.data as Hash,
    blockNumber: BigInt(raw.blockNumber as number), blockHash: raw.blockHash as Hash,
    transactionHash: raw.transactionHash as Hash, logIndex: Number(raw.logIndex) } as Log;
}

const launch: Launch = { chainId: 4663, tokenAddress: fixture.tokenAddress as Address, name: 'Sample', symbol: 'SAMPLE',
  tokenDecimals: 18, platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: 'launch-log',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  deployerAddress: '0x0000000000000000000000000000000000000001', launchBlock: 27_000_000n,
  launchTxHash: `0x${'1'.repeat(64)}`, quoteAsset: { address: fixture.quoteAddress as Address, symbol: 'NVDA', decimals: 18 },
  lifecycleStatus: 'graduated', v4PoolFee: 0, v4TickSpacing: 200 };
const venue: Venue = { id: `4663:v4_pool:${poolId}`, chainId: 4663, tokenAddress: launch.tokenAddress,
  kind: 'v4_pool', ref: poolId, sourceId: 'pons-v2-lifecycle', sourceLogId: 'initialize-log',
  effectiveFromBlock: 27_828_161n, effectiveFromLogIndex: 16, effectiveToBlock: null, official: true };
const context = { launch, venue };

describe('official Pons V4 swap runtime', () => {
  it('creates a durable source beginning at this pool Initialize block, not the current chain head', async () => {
    const { getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    expect(source.id).toBe(`pons-v2-v4:${poolId}`);
    expect(source.startBlock).toBe(27_828_161n);
    expect(source.addresses).toEqual([poolManager]);
    expect(source.poolId).toBe(poolId);
  });

  it('queries PoolManager with the indexed pool ID and decodes only matching swaps', async () => {
    const { createV4GetLogs, createV4TradeDecoder, getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    const requests: Array<Record<string, unknown>> = [];
    const fetch = createV4GetLogs({ getLogs: async (request: Record<string, unknown>) => {
      requests.push(request);
      return [asLog(swap)];
    } }, poolManager, poolId);
    const logs = await fetch(source, 27_828_161n, 27_828_165n);
    expect(requests[0]).toMatchObject({ address: poolManager, args: { id: poolId },
      fromBlock: 27_828_161n, toBlock: 27_828_165n });
    const decoder = createV4TradeDecoder(context, async () => 1_700_000_000, async () => trader, poolManager, hook);
    const batch = await decoder(logs, source);
    expect(batch.trades).toMatchObject([{ venueId: venue.id, quoteAmountRaw: 5_620_497_268_881_825_819n,
      activityKind: 'user_trade', traderAddress: trader.toLowerCase() }]);
    expect(batch.rawLogs).toHaveLength(1);
    const otherPoolLog = { ...asLog(swap), topics: [(swap.topics as Hash[])[0], `0x${'2'.repeat(64)}` as Hash,
      ...(swap.topics as Hash[]).slice(2)] } as Log;
    expect((await decoder([otherPoolLog], source)).trades).toEqual([]);
  });

  it('rejects a swap before Initialize in the same block and keeps the source cursor', async () => {
    const { createV4TradeDecoder, getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    const early = { ...asLog(swap), blockNumber: 27_828_161n, logIndex: 15 } as Log;
    let cursor = source.startBlock - 1n;
    const report = await scanToHead(source, source.startBlock, {
      initialChunk: 1n, minChunk: 1n, maxChunk: 1n, maxRetries: 0,
      getCursor: async () => ({ sourceId: source.id, chainId: 4663, scannedToBlock: cursor,
        confirmedToBlock: cursor, status: 'backfilling' }),
      getLogs: async () => [early],
      decodeLogs: createV4TradeDecoder(context, async () => 1_700_000_000, async () => trader, poolManager, hook),
      saveIndexBatch: async (_id, _from, to) => { cursor = to; }, sleep: async () => {},
    });
    expect(report.missingRanges).toMatchObject([{ fromBlock: 27_828_161n, toBlock: 27_828_161n }]);
    expect(cursor).toBe(source.startBlock - 1n);
  });

  it('classifies an actual hook swap as protocol activity without duplicating the log', async () => {
    const { createV4TradeDecoder, getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    const hookLog = { ...asLog(swap), topics: encodeEventTopics({ abi: [v4SwapEvent], eventName: 'Swap',
      args: { id: poolId, sender: hook } }) } as Log;
    const batch = await createV4TradeDecoder(context, async () => 1_700_000_000, async () => trader, poolManager, hook)([hookLog], source);
    expect(batch.trades).toHaveLength(1);
    expect(batch.trades[0].activityKind).toBe('protocol_fee_conversion');
    expect(batch.rawLogs).toHaveLength(1);
  });

  it('fetches distinct block timestamps concurrently instead of one round trip at a time', async () => {
    const { createV4TradeDecoder, getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    const first = asLog(swap) as Log;
    const second = { ...asLog(swap), blockNumber: first.blockNumber! + 1n,
      transactionHash: `0x${'2'.repeat(64)}` as Hash } as Log;
    const requestedBlocks: bigint[] = [];
    const releases = new Map<bigint, (value: number) => void>();
    const getTimestamp = (blockNumber: bigint) => {
      requestedBlocks.push(blockNumber);
      return new Promise<number>((resolve) => { releases.set(blockNumber, resolve); });
    };
    const decoder = createV4TradeDecoder(context, getTimestamp, async () => trader, poolManager, hook);
    const resultPromise = decoder([first, second], source);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedBlocks).toHaveLength(2);
    for (const release of releases.values()) release(1_700_000_000);
    const batch = await resultPromise;
    expect(batch.trades).toHaveLength(2);
  });

  it('fetches distinct transaction traders concurrently instead of one round trip at a time', async () => {
    const { createV4TradeDecoder, getV4PoolSources } = await import('./v4Runtime.js');
    const [source] = getV4PoolSources([context], poolManager);
    const first = asLog(swap) as Log;
    const second = { ...asLog(swap), transactionHash: `0x${'2'.repeat(64)}` as Hash } as Log;
    const requestedHashes: Hash[] = [];
    const releases = new Map<Hash, (value: Address) => void>();
    const getTrader = (txHash: Hash) => {
      requestedHashes.push(txHash);
      return new Promise<Address>((resolve) => { releases.set(txHash, resolve); });
    };
    const decoder = createV4TradeDecoder(context, async () => 1_700_000_000, getTrader, poolManager, hook);
    const resultPromise = decoder([first, second], source);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedHashes).toHaveLength(2);
    for (const release of releases.values()) release(trader);
    const batch = await resultPromise;
    expect(batch.trades).toHaveLength(2);
  });
});
