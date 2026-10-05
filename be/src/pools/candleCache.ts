import type { Pool, PoolClient } from 'pg';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { poolPriceInQuote } from './valuation.js';
import { assetDecimals, type PoolKey } from './stats.js';

export const POOL_CANDLE_INTERVALS = [60, 300, 900, 3600, 86400] as const;

interface DirtyKey { chainId: number; protocol: string; poolId: string; bucketStart: number }
interface CandleKey extends DirtyKey { intervalSeconds: number }

function affected(dirty: readonly DirtyKey[]): CandleKey[] {
  const keys = new Map<string, CandleKey>();
  for (const row of dirty) for (const intervalSeconds of POOL_CANDLE_INTERVALS) {
    const bucketStart = Math.floor(row.bucketStart / intervalSeconds) * intervalSeconds;
    const key = { ...row, intervalSeconds, bucketStart };
    keys.set(`${row.chainId}:${row.protocol}:${row.poolId}:${intervalSeconds}:${bucketStart}`, key);
  }
  return [...keys.values()];
}

async function rebuild(client: PoolClient, key: CandleKey): Promise<void> {
  const params = [key.chainId, key.protocol, key.poolId, key.intervalSeconds, key.bucketStart];
  const result = await client.query(`SELECT sqrt_price_x96 FROM pool_trades
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp >= $5 AND timestamp < $5 + $4
    ORDER BY block_number, log_index, tx_hash`, params);
  const prices = result.rows.map((row) => BigInt(String(row.sqrt_price_x96))) as bigint[];
  if (prices.length === 0) {
    await client.query(`DELETE FROM pool_candles WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
      AND interval_seconds=$4 AND bucket_start=$5`, params);
    return;
  }
  let high = prices[0]!;
  let low = prices[0]!;
  for (const price of prices) {
    if (price > high) high = price;
    if (price < low) low = price;
  }
  await client.query(`INSERT INTO pool_candles (chain_id,protocol,pool_id,interval_seconds,bucket_start,
    open_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_sqrt_price_x96,trade_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (chain_id,protocol,pool_id,interval_seconds,bucket_start) DO UPDATE SET
      open_sqrt_price_x96=EXCLUDED.open_sqrt_price_x96,
      high_sqrt_price_x96=EXCLUDED.high_sqrt_price_x96,
      low_sqrt_price_x96=EXCLUDED.low_sqrt_price_x96,
      close_sqrt_price_x96=EXCLUDED.close_sqrt_price_x96,
      trade_count=EXCLUDED.trade_count`,
  [...params, prices[0]!.toString(), high.toString(), low.toString(), prices.at(-1)!.toString(), prices.length]);
}

/** Rebuild at most `limit` dirty minute buckets and all containing intervals atomically. */
export async function refreshDirtyPoolCandles(pool: Pool, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid pool candle limit');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(`SELECT chain_id,protocol,pool_id,bucket_start FROM pool_candle_dirty_buckets
      ORDER BY bucket_start,chain_id,protocol,pool_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    const dirty: DirtyKey[] = claimed.rows.map((row) => ({ chainId: Number(row.chain_id),
      protocol: String(row.protocol), poolId: String(row.pool_id), bucketStart: Number(row.bucket_start) }));
    for (const key of affected(dirty)) await rebuild(client, key);
    for (const row of dirty) await client.query(`DELETE FROM pool_candle_dirty_buckets
      WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND bucket_start=$4`,
    [row.chainId, row.protocol, row.poolId, row.bucketStart]);
    await client.query('COMMIT');
    return dirty.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export interface PoolCandleResponse {
  intervalSeconds: number; bucketStart: number; open: string; high: string; low: string; close: string; tradeCount: number;
}

/** Read persisted pool-only candles, flipping high/low when the displayed side is currency1. */
export async function readPoolCandles(pool: Pool, key: PoolKey, displayedToken: string,
  intervalSeconds: number, before?: number, options: { rpcClient?: UsdPriceClient } = {},
): Promise<{ items: PoolCandleResponse[]; complete: boolean }> {
  if (!POOL_CANDLE_INTERVALS.includes(intervalSeconds as typeof POOL_CANDLE_INTERVALS[number])) throw new Error('Invalid pool candle interval');
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('Invalid pool candle boundary');
  const result = await pool.query('SELECT currency0,currency1,coverage_status FROM pool_catalog WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true',
    [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const catalog = result.rows[0] as { currency0: string; currency1: string; coverage_status: string } | undefined;
  if (!catalog) throw new Error('Pool not found');
  const displayed = displayedToken.toLowerCase();
  if (displayed !== catalog.currency0 && displayed !== catalog.currency1) throw new Error('Token is not in pool');
  const displayedIsCurrency0 = displayed === catalog.currency0;
  const [decimals0, decimals1] = await Promise.all([
    assetDecimals(options.rpcClient, catalog.currency0), assetDecimals(options.rpcClient, catalog.currency1),
  ]);
  const tokenDecimals = displayedIsCurrency0 ? decimals0 : decimals1;
  const quoteDecimals = displayedIsCurrency0 ? decimals1 : decimals0;
  if (tokenDecimals === null || quoteDecimals === null) return { items: [], complete: false };
  const bound = before ?? Math.floor(Date.now() / 1000) + 1;
  const candles = await pool.query(`SELECT bucket_start,open_sqrt_price_x96,high_sqrt_price_x96,
    low_sqrt_price_x96,close_sqrt_price_x96,trade_count FROM pool_candles
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND interval_seconds=$4 AND bucket_start < $5
    ORDER BY bucket_start DESC LIMIT 500`, [key.chainId, key.protocol, key.poolId.toLowerCase(), intervalSeconds, bound]);
  const items: PoolCandleResponse[] = [];
  for (const row of candles.rows) {
    const price = (field: string) => poolPriceInQuote(BigInt(String(row[field])), tokenDecimals, quoteDecimals, displayedIsCurrency0);
    const open = price('open_sqrt_price_x96');
    const high = price(displayedIsCurrency0 ? 'high_sqrt_price_x96' : 'low_sqrt_price_x96');
    const low = price(displayedIsCurrency0 ? 'low_sqrt_price_x96' : 'high_sqrt_price_x96');
    const close = price('close_sqrt_price_x96');
    if (open === null || high === null || low === null || close === null) return { items: [], complete: false };
    items.push({ intervalSeconds, bucketStart: Number(row.bucket_start), open, high, low, close,
      tradeCount: Number(row.trade_count) });
  }
  const dirty = await pool.query(`SELECT 1 FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol=$2
    AND pool_id=$3 AND bucket_start < $4 LIMIT 1`, [key.chainId, key.protocol, key.poolId.toLowerCase(), bound]);
  return { items, complete: catalog.coverage_status === 'caught_up' && dirty.rowCount === 0 };
}

/** Daily candles cover whole UTC days; minute candles cover the two partial edge days. */
export async function readPoolHighLow(pool: Pool, key: PoolKey, displayedToken: string, asOf: number,
  options: { rpcClient?: UsdPriceClient } = {},
): Promise<{ high: string | null; low: string | null; complete: boolean }> {
  if (!Number.isSafeInteger(asOf) || asOf < 1) throw new Error('Invalid pool high/low time');
  const found = await pool.query('SELECT currency0,currency1,coverage_status FROM pool_catalog WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true',
    [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const catalog = found.rows[0] as { currency0: string; currency1: string; coverage_status: string } | undefined;
  if (!catalog) throw new Error('Pool not found');
  const displayed = displayedToken.toLowerCase();
  if (displayed !== catalog.currency0 && displayed !== catalog.currency1) throw new Error('Token is not in pool');
  const isCurrency0 = displayed === catalog.currency0;
  const [d0, d1] = await Promise.all([
    assetDecimals(options.rpcClient, catalog.currency0), assetDecimals(options.rpcClient, catalog.currency1),
  ]);
  const tokenDecimals = isCurrency0 ? d0 : d1;
  const quoteDecimals = isCurrency0 ? d1 : d0;
  if (tokenDecimals === null || quoteDecimals === null || catalog.coverage_status !== 'caught_up') {
    return { high: null, low: null, complete: false };
  }
  const day = 86400;
  const since = asOf - 52 * 7 * day;
  const firstFullDay = Math.ceil(since / day) * day;
  const lastFullDay = Math.floor(asOf / day) * day;
  const firstMinute = Math.floor(since / 60) * 60;
  const afterLastMinute = (Math.floor(asOf / 60) + 1) * 60;
  const params = [key.chainId, key.protocol, key.poolId.toLowerCase(), firstMinute,
    afterLastMinute, firstFullDay, lastFullDay];
  const dirty = await pool.query(`SELECT 1 FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol=$2
    AND pool_id=$3 AND bucket_start >= $4 AND bucket_start < $5 LIMIT 1`, params.slice(0, 5));
  if (dirty.rowCount) return { high: null, low: null, complete: false };
  const rows = await pool.query(`SELECT max(high_sqrt_price_x96)::text AS high,
    min(low_sqrt_price_x96)::text AS low FROM pool_candles
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND (
      (interval_seconds=86400 AND bucket_start >= $6 AND bucket_start < $7)
      OR (interval_seconds=60 AND bucket_start >= $4 AND bucket_start < $6)
      OR (interval_seconds=60 AND bucket_start >= $7 AND bucket_start < $5))`, params);
  const rawHigh = rows.rows[0]?.high as string | null;
  const rawLow = rows.rows[0]?.low as string | null;
  if (rawHigh === null || rawLow === null) return { high: null, low: null, complete: true };
  return { high: poolPriceInQuote(BigInt(isCurrency0 ? rawHigh : rawLow), tokenDecimals, quoteDecimals, isCurrency0),
    low: poolPriceInQuote(BigInt(isCurrency0 ? rawLow : rawHigh), tokenDecimals, quoteDecimals, isCurrency0), complete: true };
}
