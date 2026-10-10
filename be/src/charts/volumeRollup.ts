import type { PoolClient } from 'pg';

// Volume rollups: 60 s buckets are built from the trades of each dirty minute; every coarser interval is
// rebuilt from the next finer table, so updating today's daily bar never re-reads a day of trades.
export const VOLUME_INTERVALS = [60, 300, 3600, 14400, 86400] as const;
const MAX_PRICE_AGE_SECONDS = 86_400;

interface LaunchMinute { chainId: number; tokenAddress: string; bucketStart: number }
interface PoolMinute { chainId: number; protocol: string; poolId: string; bucketStart: number }

function finerOf(interval: number): number {
  const index = VOLUME_INTERVALS.indexOf(interval as (typeof VOLUME_INTERVALS)[number]);
  return VOLUME_INTERVALS[index - 1]!;
}

function distinct<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return [...byKey.values()];
}

function valuesList(rows: readonly (readonly unknown[])[], casts: readonly string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const sql = rows.map((row) => {
    const placeholders = row.map((value, column) => { params.push(value); return `$${params.length}::${casts[column]}`; });
    return `(${placeholders.join(',')})`;
  }).join(',');
  return { sql, params };
}

// ---- launches ----

export async function rebuildLaunchVolume(client: PoolClient, dirty: readonly LaunchMinute[]): Promise<void> {
  if (dirty.length === 0) return;
  for (const interval of VOLUME_INTERVALS) {
    const keys = distinct(dirty.map((row) => ({ chainId: row.chainId, tokenAddress: row.tokenAddress,
      bucketStart: Math.floor(row.bucketStart / interval) * interval })), (row) => `${row.chainId}:${row.tokenAddress}:${row.bucketStart}`);
    const list = valuesList(keys.map((row) => [row.chainId, row.tokenAddress, row.bucketStart]), ['int', 'text', 'bigint']);
    await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql})
      DELETE FROM launch_volume_buckets b USING keys k WHERE b.chain_id = k.chain_id AND b.token_address = k.token_address
        AND b.bucket_start = k.bucket_start AND b.interval_seconds = ${interval}`, list.params);
    if (interval === 60) {
      // Same valuation rule as the trade page and usd_candles: the latest oracle round at or before the trade's
      // (block, log), rejected when it is from the future or older than 24 h at the trade's timestamp.
      await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql}),
        priced AS (
          SELECT k.chain_id, k.token_address, v.kind AS venue_kind, k.bucket_start,
            CASE WHEN r.answer_raw IS NULL OR l.quote_asset_decimals IS NULL OR t.timestamp - r.updated_at < 0
                   OR t.timestamp - r.updated_at > ${MAX_PRICE_AGE_SECONDS} THEN NULL
                 ELSE t.quote_amount_raw::numeric * r.answer_raw::numeric / power(10::numeric, l.quote_asset_decimals + r.decimals) END AS usd
          FROM keys k
          JOIN trades t ON t.chain_id = k.chain_id AND t.token_address = k.token_address
            AND t.timestamp >= k.bucket_start AND t.timestamp < k.bucket_start + 60
          JOIN venues v ON v.id = t.venue_id AND v.official = true
          JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
          LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address
            AND f.verification_status = 'verified'
          LEFT JOIN LATERAL (
            SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
            WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
            ORDER BY block_number DESC, log_index DESC LIMIT 1
          ) r ON true
        )
        INSERT INTO launch_volume_buckets (chain_id, token_address, venue_kind, interval_seconds, bucket_start, volume_usd, trade_count, unpriced_count)
        SELECT chain_id, token_address, venue_kind, 60, bucket_start, coalesce(sum(usd), 0), count(*)::int, (count(*) FILTER (WHERE usd IS NULL))::int
        FROM priced GROUP BY chain_id, token_address, venue_kind, bucket_start`, list.params);
    } else {
      await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql})
        INSERT INTO launch_volume_buckets (chain_id, token_address, venue_kind, interval_seconds, bucket_start, volume_usd, trade_count, unpriced_count)
        SELECT k.chain_id, k.token_address, b.venue_kind, ${interval}, k.bucket_start, sum(b.volume_usd), sum(b.trade_count)::int, sum(b.unpriced_count)::int
        FROM keys k JOIN launch_volume_buckets b ON b.chain_id = k.chain_id AND b.token_address = k.token_address
          AND b.interval_seconds = ${finerOf(interval)} AND b.bucket_start >= k.bucket_start AND b.bucket_start < k.bucket_start + ${interval}
        GROUP BY k.chain_id, k.token_address, b.venue_kind, k.bucket_start`, list.params);
    }
  }
}

// ---- pools ----

export async function rebuildPoolVolume(client: PoolClient, dirty: readonly PoolMinute[]): Promise<void> {
  if (dirty.length === 0) return;
  for (const interval of VOLUME_INTERVALS) {
    const keys = distinct(dirty.map((row) => ({ chainId: row.chainId, protocol: row.protocol, poolId: row.poolId,
      bucketStart: Math.floor(row.bucketStart / interval) * interval })), (row) => `${row.chainId}:${row.protocol}:${row.poolId}:${row.bucketStart}`);
    const list = valuesList(keys.map((row) => [row.chainId, row.protocol, row.poolId, row.bucketStart]), ['int', 'text', 'text', 'bigint']);
    await client.query(`WITH keys(chain_id, protocol, pool_id, bucket_start) AS (VALUES ${list.sql})
      DELETE FROM pool_volume_buckets b USING keys k WHERE b.chain_id = k.chain_id AND b.protocol = k.protocol
        AND b.pool_id = k.pool_id AND b.bucket_start = k.bucket_start AND b.interval_seconds = ${interval}`, list.params);
    if (interval === 60) {
      // Each side is valued with its own verified feed, decimals-free: |raw| * answer / 10^feed_decimals.
      await client.query(`WITH keys(chain_id, protocol, pool_id, bucket_start) AS (VALUES ${list.sql}),
        priced AS (
          SELECT k.chain_id, k.protocol, k.pool_id, k.bucket_start,
            CASE WHEN r0.answer_raw IS NULL OR pt.timestamp - r0.updated_at < 0 OR pt.timestamp - r0.updated_at > ${MAX_PRICE_AGE_SECONDS} THEN NULL
                 ELSE abs(pt.amount0_raw::numeric) * r0.answer_raw::numeric / power(10::numeric, r0.decimals) END AS usd0,
            CASE WHEN r1.answer_raw IS NULL OR pt.timestamp - r1.updated_at < 0 OR pt.timestamp - r1.updated_at > ${MAX_PRICE_AGE_SECONDS} THEN NULL
                 ELSE abs(pt.amount1_raw::numeric) * r1.answer_raw::numeric / power(10::numeric, r1.decimals) END AS usd1,
            (f0.feed_address IS NOT NULL) AS has_feed0, (f1.feed_address IS NOT NULL) AS has_feed1
          FROM keys k
          JOIN pool_trades pt ON pt.chain_id = k.chain_id AND pt.protocol = k.protocol AND pt.pool_id = k.pool_id
            AND pt.timestamp >= k.bucket_start AND pt.timestamp < k.bucket_start + 60
          JOIN pool_catalog c ON c.chain_id = pt.chain_id AND c.protocol = pt.protocol AND c.pool_id = pt.pool_id
          LEFT JOIN quote_usd_feeds f0 ON f0.chain_id = c.chain_id AND f0.quote_asset_address = c.currency0 AND f0.verification_status = 'verified'
          LEFT JOIN quote_usd_feeds f1 ON f1.chain_id = c.chain_id AND f1.quote_asset_address = c.currency1 AND f1.verification_status = 'verified'
          LEFT JOIN LATERAL (
            SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
            WHERE chain_id = f0.chain_id AND feed_address = f0.feed_address AND (block_number, log_index) <= (pt.block_number, pt.log_index)
            ORDER BY block_number DESC, log_index DESC LIMIT 1
          ) r0 ON true
          LEFT JOIN LATERAL (
            SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
            WHERE chain_id = f1.chain_id AND feed_address = f1.feed_address AND (block_number, log_index) <= (pt.block_number, pt.log_index)
            ORDER BY block_number DESC, log_index DESC LIMIT 1
          ) r1 ON true
        )
        INSERT INTO pool_volume_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, trade_count, usd_scaled0, unpriced0, usd_scaled1, unpriced1)
        SELECT chain_id, protocol, pool_id, 60, bucket_start, count(*)::int,
          CASE WHEN bool_or(has_feed0) THEN coalesce(sum(usd0), 0) END, (count(*) FILTER (WHERE usd0 IS NULL))::int,
          CASE WHEN bool_or(has_feed1) THEN coalesce(sum(usd1), 0) END, (count(*) FILTER (WHERE usd1 IS NULL))::int
        FROM priced GROUP BY chain_id, protocol, pool_id, bucket_start`, list.params);
    } else {
      await client.query(`WITH keys(chain_id, protocol, pool_id, bucket_start) AS (VALUES ${list.sql})
        INSERT INTO pool_volume_buckets (chain_id, protocol, pool_id, interval_seconds, bucket_start, trade_count, usd_scaled0, unpriced0, usd_scaled1, unpriced1)
        SELECT k.chain_id, k.protocol, k.pool_id, ${interval}, k.bucket_start, sum(b.trade_count)::int,
          sum(b.usd_scaled0), sum(b.unpriced0)::int, sum(b.usd_scaled1), sum(b.unpriced1)::int
        FROM keys k JOIN pool_volume_buckets b ON b.chain_id = k.chain_id AND b.protocol = k.protocol AND b.pool_id = k.pool_id
          AND b.interval_seconds = ${finerOf(interval)} AND b.bucket_start >= k.bucket_start AND b.bucket_start < k.bucket_start + ${interval}
        GROUP BY k.chain_id, k.protocol, k.pool_id, k.bucket_start`, list.params);
    }
  }
}

// A new oracle round can price trades that were waiting for one. Re-queue only the minutes of trades that could be
// affected (after the changed block, within a day of the rounds) so the candle workers rebuild their rollups.
export async function redirtyVolumeForPriceChange(client: PoolClient, change: { chainId: number; quoteAssetAddress: string; fromBlock: bigint }): Promise<void> {
  const quote = change.quoteAssetAddress.toLowerCase();
  const since = Math.floor(Date.now() / 1000) - 2 * MAX_PRICE_AGE_SECONDS;
  await client.query(`INSERT INTO candle_dirty_buckets (chain_id, token_address, bucket_start)
    SELECT DISTINCT t.chain_id, t.token_address, (t.timestamp / 60) * 60
    FROM launches l JOIN trades t ON t.chain_id = l.chain_id AND t.token_address = l.token_address
    WHERE l.chain_id = $1 AND l.quote_asset_address = $2 AND t.block_number >= $3::bigint AND t.timestamp >= $4
    ON CONFLICT DO NOTHING`, [change.chainId, quote, change.fromBlock.toString(), since]);
  await client.query(`INSERT INTO pool_candle_dirty_buckets (chain_id, protocol, pool_id, bucket_start)
    SELECT DISTINCT pt.chain_id, pt.protocol, pt.pool_id, (pt.timestamp / 60) * 60
    FROM pool_catalog c JOIN pool_trades pt ON pt.chain_id = c.chain_id AND pt.protocol = c.protocol AND pt.pool_id = c.pool_id
    WHERE c.chain_id = $1 AND (c.currency0 = $2 OR c.currency1 = $2) AND pt.block_number >= $3::bigint AND pt.timestamp >= $4
    ON CONFLICT DO NOTHING`, [change.chainId, quote, change.fromBlock.toString(), since]);
}
