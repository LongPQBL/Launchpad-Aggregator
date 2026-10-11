import type { Pool } from 'pg';
import { robinhood } from '../chains/robinhood.js';
import { readUsdPriceAtBlock, type UsdPriceClient } from '../market/usdPricing.js';
import { readPoolAmounts } from './poolAmounts.js';
import { assetDecimals } from './stats.js';
import { pickQuoteSide, tvlFromAmounts, type CatalogRow } from './tvlCapture.js';
import { TVL_BUCKET_INTERVALS } from './tvlSnapshots.js';

export interface BackfillClient extends UsdPriceClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface GridPoint { interval: number; bucketStart: number; sampleAt: number }

// How far back each bucket size is backfilled: the 1W chart reads hourly buckets, 1M reads 4-hour ones, 1Y reads daily ones.
const WINDOW_DAYS: Record<number, number> = { 3600: 7, 14_400: 30, 86_400: Number.POSITIVE_INFINITY };

/** Every fully ended bucket in each interval's window, sampled at its last second (matching "last snapshot in the bucket"). */
export function buildGrid(nowSeconds: number, days: number): GridPoint[] {
  const points: GridPoint[] = [];
  for (const interval of TVL_BUCKET_INTERVALS) {
    const windowSeconds = Math.min(WINDOW_DAYS[interval]!, days) * 86_400;
    const lastEnded = Math.floor((nowSeconds + 1) / interval) * interval - interval;
    for (let bucketStart = lastEnded; bucketStart >= nowSeconds - windowSeconds; bucketStart -= interval) {
      points.push({ interval, bucketStart, sampleAt: bucketStart + interval - 1 });
    }
  }
  return points.sort((a, b) => a.sampleAt - b.sampleAt);
}

/** Finds the latest block whose timestamp is <= a target time, narrowing with interpolation between known blocks and sharing what it learns. */
export function createBlockLocator(client: Pick<BackfillClient, 'getBlockNumber' | 'getBlock'>) {
  const known = new Map<bigint, number>();
  const timestampOf = async (blockNumber: bigint): Promise<number> => {
    const cached = known.get(blockNumber);
    if (cached !== undefined) return cached;
    const timestamp = Number((await client.getBlock({ blockNumber })).timestamp);
    known.set(blockNumber, timestamp);
    return timestamp;
  };
  return async function blockAtOrBefore(targetSeconds: number): Promise<{ block: bigint; timestamp: number } | null> {
    let high = await client.getBlockNumber();
    let low = 1n;
    const lowTs = await timestampOf(low);
    if (lowTs > targetSeconds) return null;
    if ((await timestampOf(high)) <= targetSeconds) return { block: high, timestamp: await timestampOf(high) };
    // Tighten with the closest blocks already known on either side of the target.
    for (const [block, timestamp] of known) {
      if (timestamp <= targetSeconds && block > low) low = block;
      if (timestamp > targetSeconds && block < high) high = block;
    }
    for (let step = 0; step < 64 && high - low > 1n; step += 1) {
      const lowT = known.get(low) ?? await timestampOf(low);
      const highT = known.get(high) ?? await timestampOf(high);
      const ratio = highT === lowT ? 0.5 : (targetSeconds - lowT) / (highT - lowT);
      let guess = low + BigInt(Math.floor(Number(high - low) * Math.min(0.99, Math.max(0.01, ratio))));
      if (guess <= low) guess = low + 1n;
      if (guess >= high) guess = high - 1n;
      if ((await timestampOf(guess)) <= targetSeconds) low = guess; else high = guess;
    }
    return { block: low, timestamp: await timestampOf(low) };
  };
}

export interface BackfillOptions { chainId?: number; days: number; poolConcurrency?: number; nowSeconds: number; log?: (message: string) => void }
export interface BackfillResult { pools: number; inserted: number; skippedExisting: number; unreadable: number }

/**
 * Fills pool_tvl_buckets for past buckets from archive state: for each grid point the pool's amounts at that block and the quote feed's
 * answer at the same block. Existing buckets (live snapshots) are never overwritten, a point that cannot be read or priced is left
 * empty (never guessed), and a pool is not read before the block it was created in. Safe to re-run: it only fills what is missing.
 */
export async function backfillPoolTvl(pool: Pool, client: BackfillClient, options: BackfillOptions): Promise<BackfillResult> {
  const chainId = options.chainId ?? robinhood.id;
  const log = options.log ?? (() => {});
  const grid = buildGrid(options.nowSeconds, options.days);
  const locate = createBlockLocator(client);
  const blocks = new Map<number, bigint | null>();
  for (const point of grid) blocks.set(point.sampleAt, (await locate(point.sampleAt))?.block ?? null);
  log(`located ${blocks.size} sample blocks`);

  const pools = (await pool.query(`SELECT chain_id, protocol, pool_id, currency0, currency1, fee, tick_spacing, hooks, block_number
    FROM pool_catalog WHERE verified = true AND chain_id = $1 ORDER BY pool_id`, [chainId])).rows as Array<CatalogRow & { block_number: string }>;
  const result: BackfillResult = { pools: pools.length, inserted: 0, skippedExisting: 0, unreadable: 0 };
  const priceCache = new Map<string, Promise<number | null>>();
  const priceAt = (quote: string, block: bigint, atSeconds: number) => {
    const key = `${quote}:${block}`;
    let cached = priceCache.get(key);
    if (!cached) { cached = readUsdPriceAtBlock(pool, client, chainId, quote, block, atSeconds).catch(() => null); priceCache.set(key, cached); }
    return cached;
  };

  async function backfillOne(row: CatalogRow & { block_number: string }): Promise<void> {
    const quote = await pickQuoteSide(pool, chainId, row.currency0, row.currency1);
    const [decimals0, decimals1] = await Promise.all([assetDecimals(client, row.currency0), assetDecimals(client, row.currency1)]);
    if (quote === null || decimals0 === null || decimals1 === null) return;
    const existing = new Set((await pool.query('SELECT interval_seconds, bucket_start FROM pool_tvl_buckets WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3',
      [chainId, row.protocol, row.pool_id])).rows.map((r) => `${r.interval_seconds}:${r.bucket_start}`));
    for (const point of grid) {
      if (existing.has(`${point.interval}:${point.bucketStart}`)) { result.skippedExisting += 1; continue; }
      const block = blocks.get(point.sampleAt);
      if (block === null || block === undefined || block < BigInt(row.block_number)) continue;
      try {
        const amounts = await readPoolAmounts(client, { protocol: row.protocol, poolId: row.pool_id, currency0: row.currency0, currency1: row.currency1,
          fee: row.fee, tick_spacing: row.tick_spacing, hooks: row.hooks }, block);
        const price = amounts ? await priceAt(quote, block, point.sampleAt) : null;
        const tvlUsd = amounts && price ? tvlFromAmounts(row, amounts, quote, decimals0, decimals1, price) : null;
        if (tvlUsd === null) { result.unreadable += 1; continue; }
        await pool.query(`INSERT INTO pool_tvl_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, tvl_usd, last_captured_at)
          VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7)) ON CONFLICT DO NOTHING`,
        [chainId, row.protocol, row.pool_id, point.interval, point.bucketStart, tvlUsd, point.sampleAt]);
        result.inserted += 1;
      } catch { result.unreadable += 1; }
    }
  }

  const queue = [...pools];
  let done = 0;
  await Promise.all(Array.from({ length: Math.max(1, options.poolConcurrency ?? 4) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      await backfillOne(row);
      done += 1;
      if (done % 10 === 0 || done === pools.length) log(`pools ${done}/${pools.length} inserted=${result.inserted} unreadable=${result.unreadable}`);
    }
  }));
  return result;
}
