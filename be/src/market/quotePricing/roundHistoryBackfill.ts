import { parseAbi, parseAbiItem, type Address } from 'viem';
import type { Pool } from 'pg';
import { createBlockLocator, type BlockClient } from '../../chains/blockLocator.js';
import { upsertPriceRounds, type PriceRound } from './priceRounds.js';
import { MAX_PRICE_AGE_SECONDS } from './tradeValuation.js';

const proxyAbi = parseAbi(['function aggregator() view returns (address)']);
const aggregatorAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRound() view returns (uint256)',
  'function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)',
]);
const answerUpdated = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)');

export interface RoundHistoryClient extends BlockClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getLogs(parameters: { address: Address; event: typeof answerUpdated; args: { roundId: bigint }; fromBlock: bigint; toBlock: bigint }): Promise<readonly { blockNumber: bigint; logIndex: number }[]>;
}
export interface RoundHistoryResult { examined: number; inserted: number; alreadyStored: number; unlocated: number; reachedStart: boolean }

/**
 * Fills the oracle round history of one feed back to `fromSeconds - 24 h` (the freshness ceiling: a round older than that can never value a trade).
 * Rounds are read directly with the aggregator's `getRoundData` (no log scan over millions of blocks); each round's exact block and log index come from
 * a `getLogs` over the few blocks that share its timestamp. A round whose log cannot be found is skipped and counted, never stored with a guessed position.
 * Storing a round also marks the affected volume / candle buckets dirty (`upsertPriceRounds`), so the rollup workers recompute them. Safe to re-run.
 */
export async function backfillRoundHistory(client: RoundHistoryClient, pool: Pool, chainId: number, feedAddress: Address, fromSeconds: number,
  options: { concurrency?: number; log?: (message: string) => void } = {}): Promise<RoundHistoryResult> {
  const log = options.log ?? (() => {});
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const aggregator = await client.readContract({ address: feedAddress, abi: proxyAbi, functionName: 'aggregator' }) as Address;
  const [latest, decimals] = await Promise.all([
    client.readContract({ address: aggregator, abi: aggregatorAbi, functionName: 'latestRound' }) as Promise<bigint>,
    client.readContract({ address: aggregator, abi: aggregatorAbi, functionName: 'decimals' }) as Promise<number>,
  ]);
  const stored = new Set((await pool.query('SELECT round_id FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, feedAddress.toLowerCase()]))
    .rows.map((row) => String(row.round_id)));
  const locate = createBlockLocator(client);
  const stopBefore = fromSeconds - MAX_PRICE_AGE_SECONDS;
  const result: RoundHistoryResult = { examined: 0, inserted: 0, alreadyStored: 0, unlocated: 0, reachedStart: false };

  async function readOne(roundId: bigint): Promise<{ round: PriceRound | null; updatedAt: number } | null> {
    let data: unknown;
    try { data = await client.readContract({ address: aggregator, abi: aggregatorAbi, functionName: 'getRoundData', args: [roundId] }); } catch { return null; }
    if (!Array.isArray(data) || typeof data[1] !== 'bigint' || typeof data[3] !== 'bigint') return null;
    const updatedAt = Number(data[3]);
    if (updatedAt <= 0 || data[1] <= 0n) return null;
    if (stored.has(roundId.toString())) return { round: null, updatedAt };
    // The blocks that carry exactly this timestamp are the only candidates for the AnswerUpdated log.
    const before = await locate(updatedAt - 1);
    const upTo = await locate(updatedAt);
    if (!upTo) return { round: null, updatedAt };
    const fromBlock = before ? before.block + 1n : 1n;
    const logs = await client.getLogs({ address: aggregator, event: answerUpdated, args: { roundId }, fromBlock, toBlock: upTo.block });
    const hit = logs[0];
    if (!hit) return { round: null, updatedAt };
    return { round: { roundId, answerRaw: data[1], decimals, startedAt: Number(data[2]), updatedAt, blockNumber: hit.blockNumber, logIndex: hit.logIndex }, updatedAt };
  }

  let next = latest;
  while (next >= 1n && !result.reachedStart) {
    const ids: bigint[] = [];
    for (let id = next; id >= 1n && ids.length < concurrency * 4; id -= 1n) ids.push(id);
    const reads = new Array<Awaited<ReturnType<typeof readOne>>>(ids.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let index = cursor++; index < ids.length; index = cursor++) reads[index] = await readOne(ids[index]!);
    }));
    const batch: PriceRound[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const read = reads[index];
      result.examined += 1;
      if (read === null) { result.reachedStart = true; break; } // before the feed's first round
      if (read.round === null) { if (stored.has(ids[index]!.toString())) result.alreadyStored += 1; else result.unlocated += 1; } else batch.push(read.round);
      if (read.updatedAt < stopBefore) { result.reachedStart = true; break; }
    }
    if (batch.length > 0) result.inserted += await upsertPriceRounds(pool, chainId, feedAddress, batch);
    next = ids[ids.length - 1]! - 1n;
    if (next < 1n) result.reachedStart = true; // walked down to the feed's first round
    log(`${feedAddress.slice(0, 10)} examined=${result.examined} inserted=${result.inserted} stored=${result.alreadyStored} unlocated=${result.unlocated}`);
  }
  return result;
}
