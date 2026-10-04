import { decodeEventLog, parseAbi, parseAbiItem, type AbiEvent, type Address } from 'viem';
import type { Pool } from 'pg';
import { upsertPriceRounds } from './priceRounds.js';
import { MAX_PRICE_AGE_SECONDS } from './tradeValuation.js';

export interface BackfillRpcClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getLogs(parameters: { address: Address; fromBlock: bigint; toBlock: bigint; event: AbiEvent }): Promise<readonly {
    blockNumber: bigint; logIndex: number; data: `0x${string}`; topics: readonly `0x${string}`[];
  }[]>;
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

const answerUpdatedEvent = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)');
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const aggregatorAbi = parseAbi(['function aggregator() view returns (address)']);

// A real Robinhood Chain RPC provider rejected a 10,000-block eth_getLogs request with this exact
// limit (CLAUDE.md, verified live) — a single unchunked call across a wide range (this function's
// own 24h MAX_PRICE_AGE_SECONDS lookback alone can span far more than 2,000 blocks) would simply
// fail against that provider (final review, Important 5).
const MAX_LOG_RANGE_BLOCKS = 2000n;

async function getLogsChunked(
  client: BackfillRpcClient, address: Address, fromBlock: bigint, toBlock: bigint, event: AbiEvent,
): Promise<Awaited<ReturnType<BackfillRpcClient['getLogs']>>> {
  const chunks: Awaited<ReturnType<BackfillRpcClient['getLogs']>>[] = [];
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += MAX_LOG_RANGE_BLOCKS) {
    const chunkEnd = chunkStart + MAX_LOG_RANGE_BLOCKS - 1n > toBlock ? toBlock : chunkStart + MAX_LOG_RANGE_BLOCKS - 1n;
    chunks.push(await client.getLogs({ address, fromBlock: chunkStart, toBlock: chunkEnd, event }));
  }
  return chunks.flat();
}

// Binary-searches block numbers for the two unix-second range bounds (viem has no "block at
// timestamp" RPC call; Chainlink chains don't guarantee one either) — bounded to O(log head) calls.
async function blockAtOrAfter(client: BackfillRpcClient, targetSeconds: number, head: bigint): Promise<bigint> {
  let low = 0n;
  let high = head;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < targetSeconds) low = mid + 1n; else high = mid;
  }
  return low;
}

// `feedAddress` is the PROXY address — the same one callers enqueue jobs under and every read
// (findRoundAtOrBefore, the quote_usd_feeds row itself) keys by. Chainlink's AnswerUpdated event
// is emitted only by the underlying AGGREGATOR, never the proxy (verified live: 0 logs at 3 real
// proxies, real logs at their aggregators) — this function resolves the aggregator itself via the
// proxy's own aggregator() getter on every call (cheap, and correct across a phase/aggregator
// rotation) rather than trusting a possibly-stale stored aggregator_address.
export async function backfillRoundsForFeed(
  client: BackfillRpcClient, pool: Pool, chainId: number, feedAddress: Address, rangeStart: number, rangeEnd: number,
): Promise<number> {
  const head = await client.getBlockNumber();
  const aggregatorResult = await client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'aggregator' });
  if (typeof aggregatorResult !== 'string' || !aggregatorResult.startsWith('0x')) {
    throw new Error(`Invalid aggregator() response for feed ${feedAddress}`);
  }
  const aggregatorAddress = aggregatorResult as Address;
  // Widen the window backward by the same freshness ceiling valueTradeUsd enforces — a round
  // older than that could never be selected anyway, but one within it may be the only round in
  // force at rangeStart (e.g. a quiet feed whose last update predates this window entirely).
  const fromBlock = await blockAtOrAfter(client, rangeStart - MAX_PRICE_AGE_SECONDS, head);
  const toBlock = rangeEnd >= Math.floor(Date.now() / 1000) ? head : await blockAtOrAfter(client, rangeEnd, head);
  const [logs, decimalsResult] = await Promise.all([
    getLogsChunked(client, aggregatorAddress, fromBlock, toBlock, answerUpdatedEvent),
    client.readContract({ address: aggregatorAddress, abi: decimalsAbi, functionName: 'decimals' }),
  ]);
  if (typeof decimalsResult !== 'number' || !Number.isInteger(decimalsResult) || decimalsResult < 0 || decimalsResult > 255) {
    throw new Error(`Invalid decimals() for aggregator ${aggregatorAddress}`);
  }
  const rounds = logs.map((log) => {
    const decoded = decodeEventLog({ abi: [answerUpdatedEvent], data: log.data, topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]], strict: true });
    if (decoded.args.current <= 0n) throw new Error(`Invalid (non-positive) Chainlink answer for aggregator ${aggregatorAddress}`);
    return {
      roundId: decoded.args.roundId, answerRaw: decoded.args.current, decimals: decimalsResult,
      startedAt: Number(decoded.args.updatedAt), updatedAt: Number(decoded.args.updatedAt),
      blockNumber: log.blockNumber, logIndex: log.logIndex,
    };
  });
  return upsertPriceRounds(pool, chainId, feedAddress, rounds);
}
