import type { Pool } from 'pg';
import { HISTORY_INTERVALS, MAX_HISTORY_BUCKETS, type PoolDayHistory, type PoolHistoryResult } from '../pools/history.js';
import { isRollupBackfilled } from '../charts/rollupState.js';
import { TVL_BUCKET_INTERVALS } from '../pools/tvlSnapshots.js';
import { readCurrentPoolTvl } from '../pools/tvlCapture.js';

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
  fee: number | null; tickSpacing: number | null; hooks: string | null;
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
  const catalog = await pool.query(`SELECT c.protocol, c.pool_id, c.currency0, c.currency1, c.fee, c.tick_spacing, c.hooks, c.coverage_status,
      EXISTS (SELECT 1 FROM venues ov WHERE ov.chain_id = c.chain_id AND ov.token_address = $2 AND ov.official = true
        AND ov.kind IN ('v4_pool','v3_pool') AND lower(ov.ref) = c.pool_id) AS official
    FROM pool_members m JOIN pool_catalog c ON c.chain_id = m.chain_id AND c.protocol = m.protocol AND c.pool_id = m.pool_id
    WHERE m.chain_id = $1 AND m.token_address = $2 AND c.verified = true`, [chainId, token]);
  const holding: HoldingPool[] = [];
  for (const row of catalog.rows) {
    holding.push({ protocol: String(row.protocol), poolId: String(row.pool_id), currency0: String(row.currency0), currency1: String(row.currency1),
      fee: Number(row.fee), tickSpacing: Number(row.tick_spacing), hooks: String(row.hooks),
      caughtUp: row.coverage_status === 'caught_up', official: Boolean(row.official), since: await loadSince(pool, chainId, String(row.protocol), String(row.pool_id)) });
  }
  const officialRows = await pool.query(`SELECT DISTINCT kind, lower(ref) AS ref FROM venues
    WHERE chain_id = $1 AND token_address = $2 AND official = true AND kind IN ('v4_pool','v3_pool')`, [chainId, token]);
  for (const row of officialRows.rows) {
    const protocol = row.kind === 'v4_pool' ? 'uniswap_v4' : 'uniswap_v3';
    if (holding.some((holder) => holder.protocol === protocol && holder.poolId === row.ref)) continue;
    holding.push({ protocol, poolId: String(row.ref), currency0: '', currency1: '', fee: null, tickSpacing: null, hooks: null,
      caughtUp: true, official: true, since: await loadSince(pool, chainId, protocol, String(row.ref)) });
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
    FROM launch_volume_buckets b WHERE b.chain_id = $1 AND b.token_address = $2 AND b.interval_seconds = $3
      AND b.bucket_start >= $4 AND b.bucket_start < $5 AND ($6::text IS NULL OR b.venue_kind = $6)
      AND NOT EXISTS (SELECT 1 FROM candle_dirty_buckets d WHERE d.chain_id=b.chain_id AND d.token_address=b.token_address
        AND d.bucket_start >= b.bucket_start AND d.bucket_start < b.bucket_start + b.interval_seconds)
    GROUP BY b.bucket_start`, [options.chainId, token, step, first, last + step, options.venueKind ?? null]);
  const volumeByBucket = new Map<number, { tradeCount: number; volumeUsd: number | null; exact: string | null }>();
  for (const row of volume.rows) {
    const unavailable = Number(row.unpriced) > 0 || row.volume_usd === null;
    volumeByBucket.set(Number(row.bucket), { tradeCount: Number(row.trade_count), volumeUsd: unavailable ? null : Number(row.volume_usd), exact: unavailable ? null : String(row.volume_usd) });
  }
  // A minute still waiting for its rollup makes the window's totals stale.
  const pending = await pool.query(`SELECT 1 FROM candle_dirty_buckets WHERE chain_id = $1 AND token_address = $2
    AND bucket_start >= $3 AND bucket_start < $4 LIMIT 1`, [options.chainId, token, first, last + step]);

  if (pending.rowCount !== 0) {
    const dirtyStarts = (await pool.query(`SELECT bucket_start FROM (
      SELECT DISTINCT (bucket_start / $3::bigint) * $3::bigint AS bucket_start
      FROM candle_dirty_buckets WHERE chain_id=$1 AND token_address=$2 AND bucket_start >= $4 AND bucket_start < $5
    ) dirty ORDER BY bucket_start DESC LIMIT 501`, [options.chainId, token, step, first, last + step])).rows.map((row) => Number(row.bucket_start));
    for (const bucket of dirtyStarts) volumeByBucket.set(bucket, { tradeCount: 0, volumeUsd: null, exact: null });
    const liveStarts = dirtyStarts.slice(0, 20);
    if (liveStarts.length > 0) {
      const live = await pool.query(`WITH valued AS (
        SELECT d.bucket_start,
          CASE WHEN r.answer_raw IS NULL OR l.quote_asset_decimals IS NULL OR t.timestamp - r.updated_at < 0
            OR t.timestamp - r.updated_at > 86400 THEN NULL
            ELSE t.quote_amount_raw::numeric * r.answer_raw::numeric / power(10::numeric, l.quote_asset_decimals + r.decimals) END AS usd
        FROM unnest($3::bigint[]) AS d(bucket_start)
        JOIN trades t ON t.chain_id=$1 AND t.token_address=$2 AND t.timestamp >= d.bucket_start AND t.timestamp < d.bucket_start + $4
        JOIN venues v ON v.id=t.venue_id AND v.official=true AND ($5::text IS NULL OR v.kind=$5)
        JOIN launches l ON l.chain_id=t.chain_id AND l.token_address=t.token_address
        LEFT JOIN quote_usd_feeds f ON f.chain_id=l.chain_id AND f.quote_asset_address=l.quote_asset_address AND f.verification_status='verified'
        LEFT JOIN LATERAL (SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
          WHERE chain_id=f.chain_id AND feed_address=f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
          ORDER BY block_number DESC, log_index DESC LIMIT 1) r ON true
      ) SELECT bucket_start, count(*)::int AS trade_count, coalesce(sum(usd),0)::text AS volume_usd,
        (count(*) FILTER (WHERE usd IS NULL))::int AS unpriced FROM valued GROUP BY bucket_start`,
      [options.chainId, token, liveStarts, step, options.venueKind ?? null]);
      for (const row of live.rows) {
        const exact = Number(row.unpriced) > 0 ? null : trimFractionZeros(String(row.volume_usd));
        volumeByBucket.set(Number(row.bucket_start), { tradeCount: Number(row.trade_count), volumeUsd: exact === null ? null : Number(exact), exact });
      }
      for (const bucket of liveStarts) if (!live.rows.some((row) => Number(row.bucket_start) === bucket)) {
        volumeByBucket.set(bucket, { tradeCount: 0, volumeUsd: 0, exact: '0' });
      }
    }
  }

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
      const perPool = new Map<number, { tradeCount: number; usd: number | null }>();
      const rows = await pool.query(`SELECT bucket_start::bigint AS bucket, trade_count, unpriced${holder.side.side} AS unpriced,
          (usd_scaled${holder.side.side} / power(10::numeric, $6::int))::text AS volume_usd
        FROM pool_volume_buckets b WHERE b.chain_id = $1 AND b.protocol = $2 AND b.pool_id = $3 AND b.interval_seconds = $4
          AND b.bucket_start >= $5 AND b.bucket_start < ${last + step}
          AND NOT EXISTS (SELECT 1 FROM pool_candle_dirty_buckets d WHERE d.chain_id=b.chain_id AND d.protocol=b.protocol
            AND d.pool_id=b.pool_id AND d.bucket_start >= b.bucket_start AND d.bucket_start < b.bucket_start + b.interval_seconds)`,
      [options.chainId, holder.protocol, holder.poolId, step, first, holder.side.decimals]);
      for (const row of rows.rows) {
        const bucket = Number(row.bucket);
        perPool.set(bucket, { tradeCount: Number(row.trade_count),
          usd: Number(row.unpriced) > 0 || row.volume_usd === null ? null : Number(row.volume_usd) });
      }
      const dirtyStarts = (await pool.query(`SELECT bucket_start FROM (
        SELECT DISTINCT (bucket_start / $4::bigint) * $4::bigint AS bucket_start
        FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
          AND bucket_start >= $5 AND bucket_start < $6
      ) dirty ORDER BY bucket_start DESC LIMIT 501`, [options.chainId, holder.protocol, holder.poolId, step, first, last + step]))
        .rows.map((row) => Number(row.bucket_start));
      if (dirtyStarts.length > 0) complete = false;
      for (const bucket of dirtyStarts) perPool.set(bucket, { tradeCount: 0, usd: null });
      const liveStarts = dirtyStarts.slice(0, 20);
      if (liveStarts.length > 0) {
        const quoteAddress = holder.side.side === 0 ? holder.currency0 : holder.currency1;
        const live = await pool.query(`WITH valued AS (
          SELECT d.bucket_start,
            CASE WHEN r.answer_raw IS NULL OR pt.timestamp-r.updated_at < 0 OR pt.timestamp-r.updated_at > 86400 THEN NULL
              ELSE abs(pt.amount${holder.side.side}_raw::numeric) * r.answer_raw::numeric / power(10::numeric, r.decimals + $5::int) END AS usd
          FROM unnest($4::bigint[]) AS d(bucket_start)
          JOIN pool_trades pt ON pt.chain_id=$1 AND pt.protocol=$2 AND pt.pool_id=$3
            AND pt.timestamp >= d.bucket_start AND pt.timestamp < d.bucket_start + $6
          LEFT JOIN quote_usd_feeds f ON f.chain_id=pt.chain_id AND f.quote_asset_address=$7 AND f.verification_status='verified'
          LEFT JOIN LATERAL (SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
            WHERE chain_id=f.chain_id AND feed_address=f.feed_address AND (block_number, log_index) <= (pt.block_number, pt.log_index)
            ORDER BY block_number DESC, log_index DESC LIMIT 1) r ON true
        ) SELECT bucket_start, count(*)::int AS trade_count, coalesce(sum(usd),0)::text AS volume_usd,
          (count(*) FILTER (WHERE usd IS NULL))::int AS unpriced FROM valued GROUP BY bucket_start`,
        [options.chainId, holder.protocol, holder.poolId, liveStarts, holder.side.decimals, step, quoteAddress]);
        for (const row of live.rows) perPool.set(Number(row.bucket_start), { tradeCount: Number(row.trade_count),
          usd: Number(row.unpriced) > 0 ? null : Number(row.volume_usd) });
        for (const bucket of liveStarts) if (!live.rows.some((row) => Number(row.bucket_start) === bucket)) {
          perPool.set(bucket, { tradeCount: 0, usd: 0 });
        }
      }
      for (const [bucket, value] of perPool) {
        const total = otherVolume.get(bucket) ?? { tradeCount: 0, usd: 0 };
        total.tradeCount += value.tradeCount;
        total.usd = total.usd === null || value.usd === null ? null : total.usd + value.usd;
        otherVolume.set(bucket, total);
      }
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
    if (options.rpcClient && Math.abs(Math.floor(Date.now() / 1000) - options.asOf) <= 5 && holding.length > 0) {
      let total = 0;
      let available = unvalued === 0;
      for (let index = 0; index < valued.length; index += 4) {
        const current = await Promise.all(valued.slice(index, index + 4).map((holder) =>
          holder.fee === null || holder.tickSpacing === null || holder.hooks === null ? Promise.resolve(null)
            : readCurrentPoolTvl(pool, options.rpcClient!, {
              chain_id: options.chainId, protocol: holder.protocol as 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2',
              pool_id: holder.poolId, currency0: holder.currency0, currency1: holder.currency1,
              fee: holder.fee, tick_spacing: holder.tickSpacing, hooks: holder.hooks,
            }, options.asOf).catch(() => null)));
        for (const value of current) {
          if (value === null) available = false;
          else total += Number(value.tvlUsd);
        }
      }
      if (available && Number.isFinite(total)) tvlByBucket.set(last, trimFractionZeros(String(total)));
      else tvlByBucket.delete(last);
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
