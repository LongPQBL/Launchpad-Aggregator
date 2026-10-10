import type { Pool } from 'pg';
import { HISTORY_INTERVALS, MAX_HISTORY_BUCKETS, type PoolDayHistory, type PoolHistoryResult } from '../pools/history.js';
import { isRollupBackfilled } from '../charts/rollupState.js';
import { TVL_BUCKET_INTERVALS } from '../pools/tvlSnapshots.js';

function trimFractionZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/**
 * Per-bucket official USD volume and TVL for one launch, oldest first, ending at the bucket containing `asOf`.
 * Volume sums the launch's official-venue trades (curve and V4 alike) with the same oracle rule as the USD candles:
 * a bucket holding any unpriced trade is null, never a silent zero; a bucket with no trades is a real $0 only when
 * `complete`. TVL is the last snapshot taken in the bucket for the launch's official V4 pools (null when none).
 */
export async function readLaunchHistory(pool: Pool, options: {
  chainId: number; tokenAddress: string; intervalSeconds: number; buckets: number; asOf: number; complete: boolean;
  /** Only count trades of official venues of this kind (e.g. 'curve'). The TVL series belongs to the V4 pool, so it is omitted then. */
  venueKind?: string;
}): Promise<PoolHistoryResult> {
  const step = options.intervalSeconds;
  if (!(HISTORY_INTERVALS as readonly number[]).includes(step)
    || !Number.isSafeInteger(options.buckets) || options.buckets < 1 || options.buckets > MAX_HISTORY_BUCKETS
    || !Number.isSafeInteger(options.asOf) || options.asOf < 0) throw new Error('Invalid launch history window');
  const token = options.tokenAddress.toLowerCase();
  const last = Math.floor(options.asOf / step) * step;
  const first = last - (options.buckets - 1) * step;

  // Rollup rows: one per venue kind; a bucket with any unpriced trade has no volume.
  const volume = await pool.query(`SELECT bucket_start::bigint AS bucket, sum(volume_usd)::text AS volume_usd,
      sum(trade_count)::int AS trade_count, sum(unpriced_count)::int AS unpriced
    FROM launch_volume_buckets WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = $3
      AND bucket_start >= $4 AND bucket_start < $5 AND ($6::text IS NULL OR venue_kind = $6)
    GROUP BY bucket_start`, [options.chainId, token, step, first, last + step, options.venueKind ?? null]);
  const volumeByBucket = new Map<number, { tradeCount: number; volumeUsd: string | null }>();
  for (const row of volume.rows) {
    volumeByBucket.set(Number(row.bucket), {
      tradeCount: Number(row.trade_count),
      volumeUsd: Number(row.unpriced) > 0 || row.volume_usd === null ? null : trimFractionZeros(String(row.volume_usd)),
    });
  }
  // A minute still waiting for its rollup makes the window's totals stale.
  const pending = await pool.query(`SELECT 1 FROM candle_dirty_buckets WHERE chain_id = $1 AND token_address = $2
    AND bucket_start >= $3 AND bucket_start < $4 LIMIT 1`, [options.chainId, token, first, last + step]);

  const fromBuckets = (TVL_BUCKET_INTERVALS as readonly number[]).includes(step);
  const tvl = options.venueKind !== undefined ? { rows: [] } : fromBuckets
    ? await pool.query(`SELECT DISTINCT ON (b.bucket_start) b.bucket_start::bigint AS bucket, b.tvl_usd
        FROM venues v JOIN pool_tvl_buckets b ON b.chain_id = v.chain_id AND b.protocol = 'uniswap_v4' AND b.pool_id = lower(v.ref)
          AND b.interval_seconds = $4
        WHERE v.chain_id = $1 AND v.token_address = $2 AND v.official = true AND v.kind = 'v4_pool'
          AND b.bucket_start >= $3 AND b.bucket_start < $5
        ORDER BY b.bucket_start, b.last_captured_at DESC`, [options.chainId, token, first, step, last + step])
    : await pool.query(`SELECT DISTINCT ON (bucket) bucket, tvl_usd FROM (
        SELECT (floor(extract(epoch FROM s.captured_at))::bigint / $4) * $4 AS bucket, s.tvl_usd, s.captured_at
        FROM venues v JOIN pool_tvl_snapshots s ON s.chain_id = v.chain_id AND s.protocol = 'uniswap_v4' AND s.pool_id = lower(v.ref)
        WHERE v.chain_id = $1 AND v.token_address = $2 AND v.official = true AND v.kind = 'v4_pool'
          AND s.captured_at >= to_timestamp($3) AND s.captured_at < to_timestamp($5)
      ) x ORDER BY bucket, captured_at DESC`, [options.chainId, token, first, step, last + step]);
  const tvlByBucket = new Map<number, string>();
  for (const row of tvl.rows) tvlByBucket.set(Number(row.bucket), trimFractionZeros(String(row.tvl_usd)));

  // Until the backfill has covered history, a bucket without a row may just be unprocessed — not a real zero.
  const complete = options.complete && await isRollupBackfilled(pool, 'launch_volume');
  const items: PoolDayHistory[] = [];
  for (let bucket = first; bucket <= last; bucket += step) {
    const traded = volumeByBucket.get(bucket);
    items.push({
      day: bucket,
      tradeCount: traded?.tradeCount ?? 0,
      volumeUsd: traded ? traded.volumeUsd : complete ? '0' : null,
      tvlUsd: tvlByBucket.get(bucket) ?? null,
    });
  }
  return { items, complete: complete && pending.rowCount === 0, intervalSeconds: step };
}
