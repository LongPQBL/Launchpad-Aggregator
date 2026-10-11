import type { Pool } from 'pg';
import { HISTORY_INTERVALS, MAX_HISTORY_BUCKETS, type PoolDayHistory, type PoolHistoryResult } from '../pools/history.js';
import { isRollupBackfilled } from '../charts/rollupState.js';
import { TVL_BUCKET_INTERVALS } from '../pools/tvlSnapshots.js';

import type { UsdPriceClient } from './usdPricing.js';
import { pickPricedSide } from '../pools/history.js';

function trimFractionZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export interface LaunchHistoryResult extends PoolHistoryResult {
  /** Pools holding the token that the answer is built from (the official pool included); only set for the all-pools answer. */
  poolCount?: number;
  /** Pools that could not be valued in USD (no verified feed on either side) and are left out; the answer is incomplete while any exist. */
  unvaluedPools?: number;
}

interface HoldingPool {
  protocol: string; poolId: string; currency0: string; currency1: string; caughtUp: boolean; official: boolean;
  /** Earliest sign the pool existed (first swap or first TVL snapshot), unix seconds; null when neither is known. */
  since: number | null;
}

async function loadSince(pool: Pool, chainId: number, protocol: string, poolId: string): Promise<number | null> {
  const result = await pool.query(`SELECT
      (SELECT min(t.timestamp) FROM pool_trades t WHERE t.chain_id = $1 AND t.protocol = $2 AND t.pool_id = $3) AS first_trade,
      (SELECT extract(epoch FROM min(b.last_captured_at))::bigint FROM pool_tvl_buckets b
        WHERE b.chain_id = $1 AND b.protocol = $2 AND b.pool_id = $3 AND b.interval_seconds = 3600) AS first_snapshot`, [chainId, protocol, poolId]);
  const known = [result.rows[0]?.first_trade, result.rows[0]?.first_snapshot].filter((value) => value !== null && value !== undefined).map(Number);
  return known.length === 0 ? null : Math.min(...known);
}

/** Every verified pool holding the token plus the launch's official pools, even one the pool catalog does not list (its currencies are then unknown). */
async function loadHoldingPools(pool: Pool, chainId: number, token: string): Promise<HoldingPool[]> {
  const catalog = await pool.query(`SELECT c.protocol, c.pool_id, c.currency0, c.currency1, c.coverage_status,
      EXISTS (SELECT 1 FROM venues ov WHERE ov.chain_id = c.chain_id AND ov.token_address = $2 AND ov.official = true
        AND ov.kind IN ('v4_pool','v3_pool') AND lower(ov.ref) = c.pool_id) AS official
    FROM pool_members m JOIN pool_catalog c ON c.chain_id = m.chain_id AND c.protocol = m.protocol AND c.pool_id = m.pool_id
    WHERE m.chain_id = $1 AND m.token_address = $2 AND c.verified = true`, [chainId, token]);
  const holding: HoldingPool[] = [];
  for (const row of catalog.rows) {
    holding.push({ protocol: String(row.protocol), poolId: String(row.pool_id), currency0: String(row.currency0), currency1: String(row.currency1),
      caughtUp: row.coverage_status === 'caught_up', official: Boolean(row.official), since: await loadSince(pool, chainId, String(row.protocol), String(row.pool_id)) });
  }
  const officialRows = await pool.query(`SELECT DISTINCT kind, lower(ref) AS ref FROM venues
    WHERE chain_id = $1 AND token_address = $2 AND official = true AND kind IN ('v4_pool','v3_pool')`, [chainId, token]);
  for (const row of officialRows.rows) {
    const protocol = row.kind === 'v4_pool' ? 'uniswap_v4' : 'uniswap_v3';
    if (holding.some((holder) => holder.protocol === protocol && holder.poolId === row.ref)) continue;
    holding.push({ protocol, poolId: String(row.ref), currency0: '', currency1: '', caughtUp: true, official: true, since: await loadSince(pool, chainId, protocol, String(row.ref)) });
  }
  return holding;
}

/**
 * Per-bucket USD volume and TVL of a launch across every pool holding its token, oldest first, ending at the bucket containing `asOf`.
 * Volume is the launch's official volume (curve and official pool) plus the other verified pools' volume; the official pool's own
 * pool-level rows are not added again. A bucket with any unpriced swap is null, never a silent zero; a bucket with no rows is a real $0
 * only when `complete`. TVL is the sum of each pool's last snapshot in the bucket: null when a pool that already existed has none.
 * A pool with no verified USD feed cannot be valued: it is left out, counted in `unvaluedPools`, and the answer is incomplete.
 * With `venueKind` set only that official venue's volume is returned and TVL is omitted (the curve page).
 */
export async function readLaunchHistory(pool: Pool, options: {
  chainId: number; tokenAddress: string; intervalSeconds: number; buckets: number; asOf: number; complete: boolean;
  /** Only count trades of official venues of this kind (e.g. 'curve'); no other pools, no TVL. */
  venueKind?: string;
  /** Needed to read token decimals when valuing other pools' volume; without it those pools are unvalued. */
  rpcClient?: UsdPriceClient;
}): Promise<LaunchHistoryResult> {
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
  const volumeByBucket = new Map<number, { tradeCount: number; volumeUsd: number | null; exact: string | null }>();
  for (const row of volume.rows) {
    const unavailable = Number(row.unpriced) > 0 || row.volume_usd === null;
    volumeByBucket.set(Number(row.bucket), { tradeCount: Number(row.trade_count), volumeUsd: unavailable ? null : Number(row.volume_usd), exact: unavailable ? null : String(row.volume_usd) });
  }
  // A minute still waiting for its rollup makes the window's totals stale.
  const pending = await pool.query(`SELECT 1 FROM candle_dirty_buckets WHERE chain_id = $1 AND token_address = $2
    AND bucket_start >= $3 AND bucket_start < $4 LIMIT 1`, [options.chainId, token, first, last + step]);

  let complete = options.complete && await isRollupBackfilled(pool, 'launch_volume') && pending.rowCount === 0;
  const tvlByBucket = new Map<number, string>();
  let allPools: { poolCount: number; unvaluedPools: number } | null = null;
  const otherVolume = new Map<number, { tradeCount: number; usd: number | null }>();

  if (options.venueKind === undefined) {
    const holding = await loadHoldingPools(pool, options.chainId, token);
    const valued: Array<HoldingPool & { side: { decimals: number; side: 0 | 1 } | null }> = [];
    let unvalued = 0;
    for (const holder of holding) {
      // An official pool's volume is already in the launch rollup, so it needs no priced side.
      if (holder.official) { valued.push({ ...holder, side: null }); continue; }
      const side = await pickPricedSide(pool, options.chainId, holder, options.rpcClient);
      if (side) valued.push({ ...holder, side }); else unvalued += 1;
    }
    allPools = { poolCount: holding.length, unvaluedPools: unvalued };
    if (unvalued > 0) complete = false;

    // Volume of the pools that are not official venues (the official ones are already in the launch rollup).
    const others = valued.flatMap((holder) => (holder.side && !holder.official ? [{ ...holder, side: holder.side }] : []));
    if (others.length > 0 && !(await isRollupBackfilled(pool, 'pool_volume'))) complete = false;
    for (const holder of others) {
      if (!holder.caughtUp) complete = false;
      const rows = await pool.query(`SELECT bucket_start::bigint AS bucket, trade_count, unpriced${holder.side.side} AS unpriced,
          (usd_scaled${holder.side.side} / power(10::numeric, $6::int))::text AS volume_usd
        FROM pool_volume_buckets WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3 AND interval_seconds = $4
          AND bucket_start >= $5 AND bucket_start < ${last + step}`, [options.chainId, holder.protocol, holder.poolId, step, first, holder.side.decimals]);
      for (const row of rows.rows) {
        const bucket = Number(row.bucket);
        const entry = otherVolume.get(bucket) ?? { tradeCount: 0, usd: 0 };
        entry.tradeCount += Number(row.trade_count);
        entry.usd = entry.usd === null || Number(row.unpriced) > 0 || row.volume_usd === null ? null : entry.usd + Number(row.volume_usd);
        otherVolume.set(bucket, entry);
      }
      const dirty = await pool.query(`SELECT 1 FROM pool_candle_dirty_buckets WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3
        AND bucket_start >= $4 AND bucket_start < $5 LIMIT 1`, [options.chainId, holder.protocol, holder.poolId, first, last + step]);
      if (dirty.rowCount !== 0) complete = false;
    }

    // TVL: each valued pool's last snapshot per bucket.
    const fromBuckets = (TVL_BUCKET_INTERVALS as readonly number[]).includes(step);
    const perPool: Array<{ since: number | null; values: Map<number, number> }> = [];
    for (const holder of valued) {
      const rows = fromBuckets
        ? await pool.query(`SELECT bucket_start::bigint AS bucket, tvl_usd::text AS tvl_usd FROM pool_tvl_buckets
            WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3 AND interval_seconds = $4 AND bucket_start >= $5 AND bucket_start < $6`,
        [options.chainId, holder.protocol, holder.poolId, step, first, last + step])
        : await pool.query(`SELECT DISTINCT ON (bucket) bucket, tvl_usd::text AS tvl_usd FROM (
            SELECT (floor(extract(epoch FROM captured_at))::bigint / $4) * $4 AS bucket, tvl_usd, captured_at FROM pool_tvl_snapshots
            WHERE chain_id = $1 AND protocol = $2 AND pool_id = $3 AND captured_at >= to_timestamp($5) AND captured_at < to_timestamp($6)
          ) x ORDER BY bucket, captured_at DESC`, [options.chainId, holder.protocol, holder.poolId, step, first, last + step]);
      perPool.push({ since: holder.since, values: new Map(rows.rows.map((row) => [Number(row.bucket), Number(row.tvl_usd)])) });
    }
    for (let bucket = first; bucket <= last; bucket += step) {
      // A pool counts from the bucket in which it first shows signs of life; earlier buckets are not nulled by it.
      const counted = perPool.filter((entry) => entry.since !== null && entry.since < bucket + step);
      if (counted.length === 0 || counted.some((entry) => !entry.values.has(bucket))) continue;
      tvlByBucket.set(bucket, trimFractionZeros(String(counted.reduce((sum, entry) => sum + entry.values.get(bucket)!, 0))));
    }
  }

  const items: PoolDayHistory[] = [];
  for (let bucket = first; bucket <= last; bucket += step) {
    const official = volumeByBucket.get(bucket);
    const other = otherVolume.get(bucket);
    const hasRows = official !== undefined || other !== undefined;
    let volumeUsd: string | null;
    if (!hasRows) volumeUsd = complete ? '0' : null;
    else if ((official && official.volumeUsd === null) || (other && other.usd === null)) volumeUsd = null;
    else if (!other) volumeUsd = official!.exact === null ? null : trimFractionZeros(official!.exact);
    else volumeUsd = trimFractionZeros(String((official?.volumeUsd ?? 0) + (other.usd ?? 0)));
    items.push({ day: bucket, tradeCount: (official?.tradeCount ?? 0) + (other?.tradeCount ?? 0), volumeUsd, tvlUsd: tvlByBucket.get(bucket) ?? null });
  }
  return { items, complete, intervalSeconds: step, ...(allPools ?? {}) };
}
