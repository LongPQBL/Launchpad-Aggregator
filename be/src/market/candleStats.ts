import type { Pool } from 'pg';

const DAY = 86400;
const MINUTE = 60;
const FIFTY_TWO_WEEKS = 52 * 7 * DAY;

export interface CandleHighLow { high: string | null; low: string | null; complete: boolean }

/**
 * Use daily candles for complete UTC days and minute candles for the two partial days.
 * The rolling lower edge is rounded down to a minute, matching the candle cache's finest
 * supported resolution; this can include at most 59 seconds before the nominal 52-week cut.
 */
export async function read52WeekHighLowFromCandles(
  pool: Pool, chainId: number, tokenAddress: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CandleHighLow> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('Invalid candle high/low time');
  const since = nowSeconds - FIFTY_TWO_WEEKS;
  const firstFullDay = Math.ceil(since / DAY) * DAY;
  const lastFullDay = Math.floor(nowSeconds / DAY) * DAY;
  const firstMinute = Math.floor(since / MINUTE) * MINUTE;
  const afterLastMinute = (Math.floor(nowSeconds / MINUTE) + 1) * MINUTE;
  const params = [chainId, tokenAddress.toLowerCase(), firstMinute, afterLastMinute,
    firstFullDay, lastFullDay];
  const status = await pool.query(`SELECT
    EXISTS (SELECT 1 FROM candle_dirty_buckets d WHERE d.chain_id = $1 AND d.token_address = $2
      AND d.bucket_start >= $3 AND d.bucket_start < $4) AS dirty,
    EXISTS (SELECT 1 FROM candle_unpriced_buckets u WHERE u.chain_id = $1 AND u.token_address = $2
      AND u.bucket_start >= $3 AND u.bucket_start < $4) AS unpriced`, params.slice(0, 4));
  if (status.rows[0]?.dirty || status.rows[0]?.unpriced) return { high: null, low: null, complete: false };
  const result = await pool.query(`SELECT max(high::numeric)::text AS high, min(low::numeric)::text AS low
    FROM candles c WHERE c.chain_id = $1 AND c.token_address = $2 AND (
      (c.interval_seconds = 86400 AND c.bucket_start >= $5 AND c.bucket_start < $6)
      OR (c.interval_seconds = 60 AND c.bucket_start >= $3 AND c.bucket_start < $5)
      OR (c.interval_seconds = 60 AND c.bucket_start >= $6 AND c.bucket_start < $4)
    )`, params);
  return { high: result.rows[0]?.high ?? null, low: result.rows[0]?.low ?? null, complete: true };
}
