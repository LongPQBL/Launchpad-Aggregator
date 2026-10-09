import type { Pool } from 'pg';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { assetDecimals, type PoolKey } from './stats.js';

const DAY_SECONDS = 86_400;
export const MAX_HISTORY_DAYS = 90;

export interface PoolDayHistory {
  /** Start of the UTC day, unix seconds. */
  day: number;
  tradeCount: number;
  /** null = unavailable (incomplete coverage or an unpriced trade that day) — never a silent zero. */
  volumeUsd: string | null;
  /** Last TVL snapshot taken that day; null when no snapshot exists (V3/V2 pools have none, and snapshots are only retained for a limited window). */
  tvlUsd: string | null;
}

function trimFractionZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/**
 * Per-UTC-day USD volume and end-of-day TVL for one pool, oldest first, one entry per day in the window
 * (days with no swaps are real zeros when the pool is caught up, null otherwise).
 * Volume values each swap at the historical oracle round at or before it, exactly like the 24h pool volume.
 */
export async function readPoolDailyHistory(pool: Pool, key: PoolKey, options: { days: number; asOf: number; rpcClient?: UsdPriceClient }): Promise<{ items: PoolDayHistory[]; complete: boolean }> {
  if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > MAX_HISTORY_DAYS) throw new Error('Invalid pool history window');
  if (!Number.isSafeInteger(options.asOf) || options.asOf < 0) throw new Error('Invalid pool history time');
  const poolId = key.poolId.toLowerCase();
  const found = await pool.query('SELECT currency0, currency1, coverage_status FROM pool_catalog WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true',
    [key.chainId, key.protocol, poolId]);
  const catalog = found.rows[0] as { currency0: string; currency1: string; coverage_status: string } | undefined;
  if (!catalog) throw new Error('Pool not found');
  const complete = catalog.coverage_status === 'caught_up';

  const lastDay = Math.floor(options.asOf / DAY_SECONDS) * DAY_SECONDS;
  const firstDay = lastDay - (options.days - 1) * DAY_SECONDS;

  const [decimals0, decimals1] = await Promise.all([
    assetDecimals(options.rpcClient, catalog.currency0), assetDecimals(options.rpcClient, catalog.currency1),
  ]);
  // Same choice as the pool's 24h volume: the first side (currency1, then currency0) with a verified USD feed and known decimals.
  const sides = [
    { address: catalog.currency1, decimals: decimals1, column: 'amount1_raw' as const },
    { address: catalog.currency0, decimals: decimals0, column: 'amount0_raw' as const },
  ];
  let priced: { decimals: number; column: 'amount0_raw' | 'amount1_raw'; feedAddress: string } | null = null;
  for (const side of sides) {
    const feed = side.decimals === null ? null : await resolveVerifiedFeed(pool, key.chainId, side.address);
    if (feed && side.decimals !== null) { priced = { decimals: side.decimals, column: side.column, feedAddress: feed.feedAddress }; break; }
  }

  const volumeByDay = new Map<number, { tradeCount: number; volumeUsd: string | null }>();
  if (priced) {
    const result = await pool.query(`
      SELECT (pt.timestamp / ${DAY_SECONDS}) * ${DAY_SECONDS} AS day, count(*)::int AS trade_count,
        bool_or(r.answer_raw IS NULL OR pt.timestamp < r.updated_at OR pt.timestamp - r.updated_at > ${DAY_SECONDS}) AS has_unpriced,
        sum(abs(pt.${priced.column}::numeric) * r.answer_raw / power(10::numeric, $4::int + r.decimals))::text AS volume_usd
      FROM pool_trades pt
      LEFT JOIN LATERAL (
        SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
        WHERE chain_id = $1 AND feed_address = $5 AND (block_number, log_index) <= (pt.block_number, pt.log_index)
        ORDER BY block_number DESC, log_index DESC LIMIT 1
      ) r ON true
      WHERE pt.chain_id = $1 AND pt.protocol = $2 AND pt.pool_id = $3 AND pt.timestamp >= $6 AND pt.timestamp < $7
      GROUP BY 1`,
    [key.chainId, key.protocol, poolId, priced.decimals, priced.feedAddress, firstDay, lastDay + DAY_SECONDS]);
    for (const row of result.rows) {
      volumeByDay.set(Number(row.day), {
        tradeCount: Number(row.trade_count),
        volumeUsd: row.has_unpriced || row.volume_usd === null ? null : trimFractionZeros(String(row.volume_usd)),
      });
    }
  } else {
    // Counts only: with no verified feed the volume stays unavailable.
    const result = await pool.query(`SELECT (timestamp / ${DAY_SECONDS}) * ${DAY_SECONDS} AS day, count(*)::int AS trade_count FROM pool_trades
      WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp >= $4 AND timestamp < $5 GROUP BY 1`,
    [key.chainId, key.protocol, poolId, firstDay, lastDay + DAY_SECONDS]);
    for (const row of result.rows) volumeByDay.set(Number(row.day), { tradeCount: Number(row.trade_count), volumeUsd: null });
  }

  const tvlByDay = new Map<number, string>();
  if (key.protocol === 'uniswap_v4') {
    const result = await pool.query(`SELECT DISTINCT ON (day) day, tvl_usd FROM (
        SELECT (floor(extract(epoch FROM captured_at))::bigint / ${DAY_SECONDS}) * ${DAY_SECONDS} AS day, tvl_usd, captured_at
        FROM pool_tvl_snapshots WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
          AND captured_at >= to_timestamp($4) AND captured_at < to_timestamp($5)
      ) s ORDER BY day, captured_at DESC`, [key.chainId, key.protocol, poolId, firstDay, lastDay + DAY_SECONDS]);
    for (const row of result.rows) tvlByDay.set(Number(row.day), trimFractionZeros(String(row.tvl_usd)));
  }

  const items: PoolDayHistory[] = [];
  for (let day = firstDay; day <= lastDay; day += DAY_SECONDS) {
    const volume = volumeByDay.get(day);
    items.push({
      day,
      tradeCount: volume?.tradeCount ?? 0,
      // A day with no swaps is a real $0 only when the pool is fully indexed; otherwise it is just unknown.
      volumeUsd: !complete ? null : volume ? volume.volumeUsd : '0',
      tvlUsd: tvlByDay.get(day) ?? null,
    });
  }
  return { items, complete };
}
