import type { PoolClient } from 'pg';
import { VOLUME_INTERVALS, distinct, finerOf, valuesList } from './volumeRollup.js';

const MAX_PRICE_AGE_SECONDS = 86_400;

interface LaunchMinute { chainId: number; tokenAddress: string; bucketStart: number }

// Launch-wide USD candles, maintained like the volume rollups: a 60 s bucket is built from the trades of a dirty
// minute, every coarser bucket from the next finer one. A bucket with any unpriced trade keeps unpriced_count > 0 and is
// not served as a candle; its open/high/low/close then describe only the priced trades.
export async function rebuildUsdCandles(client: PoolClient, dirty: readonly LaunchMinute[]): Promise<void> {
  if (dirty.length === 0) return;
  for (const interval of VOLUME_INTERVALS) {
    const keys = distinct(dirty.map((row) => ({ chainId: row.chainId, tokenAddress: row.tokenAddress,
      bucketStart: Math.floor(row.bucketStart / interval) * interval })), (row) => `${row.chainId}:${row.tokenAddress}:${row.bucketStart}`);
    const list = valuesList(keys.map((row) => [row.chainId, row.tokenAddress, row.bucketStart]), ['int', 'text', 'bigint']);
    await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql})
      DELETE FROM launch_usd_candle_buckets b USING keys k WHERE b.chain_id = k.chain_id AND b.token_address = k.token_address
        AND b.bucket_start = k.bucket_start AND b.interval_seconds = ${interval}`, list.params);
    if (interval === 60) {
      // Same valuation as the trade page: the latest oracle round at or before the trade's (block, log), rejected when it is
      // from the future or older than 24 h; a zero token amount cannot be priced. The aggregate inside LATERAL keeps each
      // minute an index range scan instead of a join of every minute with every trade of the token.
      await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql})
        INSERT INTO launch_usd_candle_buckets (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, volume_usd, trade_count, unpriced_count)
        SELECT k.chain_id, k.token_address, 60, k.bucket_start, x.open, x.high, x.low, x.close, x.volume_usd, x.trade_count, x.unpriced_count
        FROM keys k
        JOIN launches l ON l.chain_id = k.chain_id AND l.token_address = k.token_address
        LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address
          AND f.verification_status = 'verified'
        CROSS JOIN LATERAL (
          SELECT (array_agg(q.price ORDER BY q.block_number, q.log_index) FILTER (WHERE q.price IS NOT NULL))[1] AS open,
            max(q.price) AS high, min(q.price) AS low,
            (array_agg(q.price ORDER BY q.block_number DESC, q.log_index DESC) FILTER (WHERE q.price IS NOT NULL))[1] AS close,
            coalesce(sum(q.usd), 0) AS volume_usd, count(*)::int AS trade_count, (count(*) FILTER (WHERE q.price IS NULL))::int AS unpriced_count
          FROM (
            SELECT p.block_number, p.log_index, p.usd,
              CASE WHEN p.usd IS NULL THEN NULL ELSE p.usd * power(10::numeric, l.token_decimals) / p.token_amount_raw::numeric END AS price
            FROM (
              SELECT t.block_number, t.log_index, t.token_amount_raw,
                CASE WHEN r.answer_raw IS NULL OR l.quote_asset_decimals IS NULL OR l.token_decimals IS NULL OR t.token_amount_raw = 0
                       OR t.timestamp - r.updated_at < 0 OR t.timestamp - r.updated_at > ${MAX_PRICE_AGE_SECONDS} THEN NULL
                     ELSE t.quote_amount_raw::numeric * r.answer_raw::numeric / power(10::numeric, l.quote_asset_decimals + r.decimals) END AS usd
              FROM trades t
              JOIN venues v ON v.id = t.venue_id AND v.official = true
              LEFT JOIN LATERAL (
                SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
                WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
                ORDER BY block_number DESC, log_index DESC LIMIT 1
              ) r ON true
              WHERE t.chain_id = k.chain_id AND t.token_address = k.token_address
                AND t.timestamp >= k.bucket_start AND t.timestamp < k.bucket_start + 60
            ) p
          ) q
          HAVING count(*) > 0
        ) x
        ON CONFLICT (chain_id, token_address, interval_seconds, bucket_start) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
          volume_usd = EXCLUDED.volume_usd, trade_count = EXCLUDED.trade_count, unpriced_count = EXCLUDED.unpriced_count`, list.params);
    } else {
      await client.query(`WITH keys(chain_id, token_address, bucket_start) AS (VALUES ${list.sql})
        INSERT INTO launch_usd_candle_buckets (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, volume_usd, trade_count, unpriced_count)
        SELECT k.chain_id, k.token_address, ${interval}, k.bucket_start, x.open, x.high, x.low, x.close, x.volume_usd, x.trade_count, x.unpriced_count
        FROM keys k CROSS JOIN LATERAL (
          SELECT (array_agg(b.open ORDER BY b.bucket_start) FILTER (WHERE b.open IS NOT NULL))[1] AS open,
            max(b.high) AS high, min(b.low) AS low,
            (array_agg(b.close ORDER BY b.bucket_start DESC) FILTER (WHERE b.close IS NOT NULL))[1] AS close,
            sum(b.volume_usd) AS volume_usd, sum(b.trade_count)::int AS trade_count, sum(b.unpriced_count)::int AS unpriced_count
          FROM launch_usd_candle_buckets b WHERE b.chain_id = k.chain_id AND b.token_address = k.token_address
            AND b.interval_seconds = ${finerOf(interval)} AND b.bucket_start >= k.bucket_start AND b.bucket_start < k.bucket_start + ${interval}
          HAVING count(*) > 0
        ) x
        ON CONFLICT (chain_id, token_address, interval_seconds, bucket_start) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
          volume_usd = EXCLUDED.volume_usd, trade_count = EXCLUDED.trade_count, unpriced_count = EXCLUDED.unpriced_count`, list.params);
    }
  }
}
