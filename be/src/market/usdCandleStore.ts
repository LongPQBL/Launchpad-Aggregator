import type { Pool } from 'pg';

const MAX_PRICE_AGE_SECONDS = 86_400;

// Same valuation rule as quotePricing/tradeValuation.ts and the trade page: the latest round at or
// before the trade's own (block, log index), rejected if older than 24h at the trade's timestamp.
// Only official venue trades count. A bucket with any unpriced trade is left out entirely.
export async function refreshUsdCandles(pool: Pool, chainId: number, tokenAddress: string, intervalSeconds: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM usd_candles WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = $3',
      [chainId, tokenAddress, intervalSeconds]);
    const result = await client.query(`
      WITH trade_usd AS (
        SELECT t.block_number, t.log_index, t.timestamp, t.token_amount_raw, t.quote_amount_raw,
          l.token_decimals, l.quote_asset_decimals, r.answer_raw, r.decimals AS price_decimals, r.updated_at
        FROM launches l
        JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
        JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
        LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address
          AND f.verification_status = 'verified'
        LEFT JOIN LATERAL (
          SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
          WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
          ORDER BY block_number DESC, log_index DESC LIMIT 1
        ) r ON true
        WHERE l.chain_id = $1 AND l.token_address = $2
      ),
      priced AS (
        SELECT block_number, log_index, timestamp, token_decimals, token_amount_raw,
          (floor(timestamp / $3) * $3)::bigint AS bucket_start,
          CASE WHEN answer_raw IS NULL OR quote_asset_decimals IS NULL OR token_decimals IS NULL OR token_amount_raw = 0
                 OR timestamp - updated_at < 0 OR timestamp - updated_at > $4 THEN NULL
               ELSE quote_amount_raw::numeric * answer_raw::numeric / power(10::numeric, quote_asset_decimals + price_decimals)
          END AS usd_value
        FROM trade_usd
      ),
      per_token AS (
        SELECT block_number, log_index, bucket_start, usd_value,
          CASE WHEN usd_value IS NULL THEN NULL ELSE usd_value * power(10::numeric, token_decimals) / token_amount_raw END AS price
        FROM priced
      )
      INSERT INTO usd_candles (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, volume_usd, trade_count)
      SELECT $1, $2, $3, bucket_start,
        (array_agg(price ORDER BY block_number, log_index))[1],
        max(price), min(price),
        (array_agg(price ORDER BY block_number DESC, log_index DESC))[1],
        sum(usd_value), count(*)
      FROM per_token
      GROUP BY bucket_start
      HAVING bool_and(usd_value IS NOT NULL)`,
    [chainId, tokenAddress, intervalSeconds, MAX_PRICE_AGE_SECONDS]);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
