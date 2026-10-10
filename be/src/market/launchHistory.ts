import type { Pool } from 'pg';
import { HISTORY_INTERVALS, MAX_HISTORY_BUCKETS, type PoolDayHistory } from '../pools/history.js';

const MAX_PRICE_AGE_SECONDS = 86_400;

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
}): Promise<{ items: PoolDayHistory[]; complete: boolean }> {
  const step = options.intervalSeconds;
  if (!(HISTORY_INTERVALS as readonly number[]).includes(step)
    || !Number.isSafeInteger(options.buckets) || options.buckets < 1 || options.buckets > MAX_HISTORY_BUCKETS
    || !Number.isSafeInteger(options.asOf) || options.asOf < 0) throw new Error('Invalid launch history window');
  const token = options.tokenAddress.toLowerCase();
  const last = Math.floor(options.asOf / step) * step;
  const first = last - (options.buckets - 1) * step;

  const volume = await pool.query(`
    WITH trade_usd AS (
      SELECT t.timestamp, t.quote_amount_raw, t.token_amount_raw, l.quote_asset_decimals, l.token_decimals,
        r.answer_raw, r.decimals AS price_decimals, r.updated_at
      FROM launches l
      JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
        AND ($7::text IS NULL OR v.kind = $7)
      JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
      LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address
        AND f.verification_status = 'verified'
      LEFT JOIN LATERAL (
        SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
        WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
        ORDER BY block_number DESC, log_index DESC LIMIT 1
      ) r ON true
      WHERE l.chain_id = $1 AND l.token_address = $2 AND t.timestamp >= $3 AND t.timestamp < $4
    )
    SELECT (floor(timestamp / $5) * $5)::bigint AS bucket, count(*)::int AS trade_count,
      bool_or(answer_raw IS NULL OR quote_asset_decimals IS NULL OR timestamp - updated_at < 0 OR timestamp - updated_at > $6) AS has_unpriced,
      sum(quote_amount_raw::numeric * answer_raw::numeric / power(10::numeric, quote_asset_decimals + price_decimals))::text AS volume_usd
    FROM trade_usd GROUP BY 1`,
  [options.chainId, token, first, last + step, step, MAX_PRICE_AGE_SECONDS, options.venueKind ?? null]);
  const volumeByBucket = new Map<number, { tradeCount: number; volumeUsd: string | null }>();
  for (const row of volume.rows) {
    volumeByBucket.set(Number(row.bucket), {
      tradeCount: Number(row.trade_count),
      volumeUsd: row.has_unpriced || row.volume_usd === null ? null : trimFractionZeros(String(row.volume_usd)),
    });
  }

  const tvl = options.venueKind !== undefined ? { rows: [] } : await pool.query(`SELECT DISTINCT ON (bucket) bucket, tvl_usd FROM (
      SELECT (floor(extract(epoch FROM s.captured_at))::bigint / $4) * $4 AS bucket, s.tvl_usd, s.captured_at
      FROM venues v JOIN pool_tvl_snapshots s ON s.chain_id = v.chain_id AND s.protocol = 'uniswap_v4' AND s.pool_id = lower(v.ref)
      WHERE v.chain_id = $1 AND v.token_address = $2 AND v.official = true AND v.kind = 'v4_pool'
        AND s.captured_at >= to_timestamp($3) AND s.captured_at < to_timestamp($5)
    ) x ORDER BY bucket, captured_at DESC`, [options.chainId, token, first, step, last + step]);
  const tvlByBucket = new Map<number, string>();
  for (const row of tvl.rows) tvlByBucket.set(Number(row.bucket), trimFractionZeros(String(row.tvl_usd)));

  const items: PoolDayHistory[] = [];
  for (let bucket = first; bucket <= last; bucket += step) {
    const traded = volumeByBucket.get(bucket);
    items.push({
      day: bucket,
      tradeCount: traded?.tradeCount ?? 0,
      volumeUsd: traded ? traded.volumeUsd : options.complete ? '0' : null,
      tvlUsd: tvlByBucket.get(bucket) ?? null,
    });
  }
  return { items, complete: options.complete };
}
