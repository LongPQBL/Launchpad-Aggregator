import type { Pool } from 'pg';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { assetDecimals, type PoolKey } from './stats.js';
import { isRollupBackfilled } from '../charts/rollupState.js';
import { TVL_BUCKET_INTERVALS } from './tvlSnapshots.js';

const DAY_SECONDS = 86_400;
export const MAX_HISTORY_DAYS = 90;
export const HISTORY_INTERVALS = [60, 300, 900, 3600, 14400, DAY_SECONDS] as const;
export const MAX_HISTORY_BUCKETS = 400;

export interface PoolHistoryResult { items: PoolDayHistory[]; complete: boolean; intervalSeconds: number }

export interface PoolDayHistory {
  /** Start of the bucket, unix seconds (the UTC day for the daily interval). */
  day: number;
  tradeCount: number;
  /** null = unavailable (incomplete coverage or an unpriced trade that day) — never a silent zero. */
  volumeUsd: string | null;
  /** Last TVL snapshot taken in the bucket; null when none exists (V3/V2 pools have none, snapshots are hourly so finer buckets are mostly empty, and they are only retained for a limited window). */
  tvlUsd: string | null;
}

function trimFractionZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** The side whose raw amounts value a swap in USD: the first of currency1, then currency0 with a verified USD feed and known decimals (the same choice as the pool's 24h volume). */
export async function pickPricedSide(pool: Pool, chainId: number, catalog: { currency0: string; currency1: string }, rpcClient?: UsdPriceClient): Promise<{ decimals: number; side: 0 | 1 } | null> {
  const [decimals0, decimals1] = await Promise.all([assetDecimals(rpcClient, catalog.currency0), assetDecimals(rpcClient, catalog.currency1)]);
  const sides = [
    { address: catalog.currency1, decimals: decimals1, side: 1 as const },
    { address: catalog.currency0, decimals: decimals0, side: 0 as const },
  ];
  for (const side of sides) {
    const feed = side.decimals === null ? null : await resolveVerifiedFeed(pool, chainId, side.address);
    if (feed && side.decimals !== null) return { decimals: side.decimals, side: side.side };
  }
  return null;
}

/**
 * Per-UTC-day USD volume and end-of-day TVL for one pool, oldest first, one entry per day in the window
 * (days with no swaps are real zeros when the pool is caught up, null otherwise).
 * Volume values each swap at the historical oracle round at or before it, exactly like the 24h pool volume.
 */
export async function readPoolDailyHistory(pool: Pool, key: PoolKey, options: { days: number; asOf: number; rpcClient?: UsdPriceClient }): Promise<PoolHistoryResult> {
  if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > MAX_HISTORY_DAYS) throw new Error('Invalid pool history window');
  return readPoolHistory(pool, key, { intervalSeconds: DAY_SECONDS, buckets: options.days, asOf: options.asOf, rpcClient: options.rpcClient });
}

/** Same series at any chart interval: `buckets` buckets of `intervalSeconds`, oldest first, ending at the bucket containing `asOf`. */
export async function readPoolHistory(pool: Pool, key: PoolKey, options: { intervalSeconds: number; buckets: number; asOf: number; rpcClient?: UsdPriceClient }): Promise<PoolHistoryResult> {
  const step = options.intervalSeconds;
  if (!(HISTORY_INTERVALS as readonly number[]).includes(step)) throw new Error('Invalid pool history window');
  if (!Number.isSafeInteger(options.buckets) || options.buckets < 1 || options.buckets > MAX_HISTORY_BUCKETS) throw new Error('Invalid pool history window');
  if (!Number.isSafeInteger(options.asOf) || options.asOf < 0) throw new Error('Invalid pool history time');
  const poolId = key.poolId.toLowerCase();
  const found = await pool.query('SELECT currency0, currency1, coverage_status FROM pool_catalog WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true',
    [key.chainId, key.protocol, poolId]);
  const catalog = found.rows[0] as { currency0: string; currency1: string; coverage_status: string } | undefined;
  if (!catalog) throw new Error('Pool not found');
  // Until the backfill has covered history, a bucket without a row may just be unprocessed — not a real zero.
  const complete = catalog.coverage_status === 'caught_up' && await isRollupBackfilled(pool, 'pool_volume');

  const lastDay = Math.floor(options.asOf / step) * step;
  const firstDay = lastDay - (options.buckets - 1) * step;

  const priced = await pickPricedSide(pool, key.chainId, catalog, options.rpcClient);

  const volumeByDay = new Map<number, { tradeCount: number; volumeUsd: string | null }>();
  // Rollup rows: |raw| * oracle answer / 10^feed decimals per side, so the priced side's token decimals are applied here.
  const rollup = await pool.query(`SELECT bucket_start::bigint AS day, trade_count,
      ${priced ? `unpriced${priced.side} AS unpriced, (usd_scaled${priced.side} / power(10::numeric, $5::int))::text AS volume_usd` : 'NULL::int AS unpriced, NULL::text AS volume_usd'}
    FROM pool_volume_buckets WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND interval_seconds=${step}
      AND bucket_start >= $4 AND bucket_start < ${lastDay + step}`, priced ? [key.chainId, key.protocol, poolId, firstDay, priced.decimals] : [key.chainId, key.protocol, poolId, firstDay]);
  for (const row of rollup.rows) {
    volumeByDay.set(Number(row.day), {
      tradeCount: Number(row.trade_count),
      volumeUsd: !priced || Number(row.unpriced) > 0 || row.volume_usd === null ? null : trimFractionZeros(String(row.volume_usd)),
    });
  }
  // A minute still waiting for its rollup makes the window's totals stale.
  const pending = await pool.query(`SELECT 1 FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
    AND bucket_start >= $4 AND bucket_start < $5 LIMIT 1`, [key.chainId, key.protocol, poolId, firstDay, lastDay + step]);
  const rollupCurrent = pending.rowCount === 0;

  const tvlByDay = new Map<number, string>();
  if (key.protocol === 'uniswap_v4') {
    const fromBuckets = (TVL_BUCKET_INTERVALS as readonly number[]).includes(step);
    const result = fromBuckets
      ? await pool.query(`SELECT bucket_start::bigint AS day, tvl_usd FROM pool_tvl_buckets
          WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND interval_seconds=$4 AND bucket_start >= $5 AND bucket_start < $6`,
      [key.chainId, key.protocol, poolId, step, firstDay, lastDay + step])
      : await pool.query(`SELECT DISTINCT ON (day) day, tvl_usd FROM (
          SELECT (floor(extract(epoch FROM captured_at))::bigint / ${step}) * ${step} AS day, tvl_usd, captured_at
          FROM pool_tvl_snapshots WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
            AND captured_at >= to_timestamp($4) AND captured_at < to_timestamp($5)
        ) s ORDER BY day, captured_at DESC`, [key.chainId, key.protocol, poolId, firstDay, lastDay + step]);
    for (const row of result.rows) tvlByDay.set(Number(row.day), trimFractionZeros(String(row.tvl_usd)));
  }

  const items: PoolDayHistory[] = [];
  for (let day = firstDay; day <= lastDay; day += step) {
    const volume = volumeByDay.get(day);
    items.push({
      day,
      tradeCount: volume?.tradeCount ?? 0,
      // A day with no swaps is a real $0 only when the pool is fully indexed; otherwise it is just unknown.
      volumeUsd: !complete ? null : volume ? volume.volumeUsd : '0',
      tvlUsd: tvlByDay.get(day) ?? null,
    });
  }
  return { items, complete: complete && rollupCurrent, intervalSeconds: step };
}
