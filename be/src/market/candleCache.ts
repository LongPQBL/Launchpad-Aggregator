import type { Pool, PoolClient } from 'pg';
import type { Address, Hash } from 'viem';
import type { Trade } from '../domain/types.js';
import { rebuildLaunchVolume } from '../charts/volumeRollup.js';
import { rebuildUsdCandles } from '../charts/usdCandleRollup.js';
import { buildOfficialCandles, type Candle } from './aggregate.js';

export const CANDLE_INTERVALS = [60, 300, 900, 3600, 14400, 86400] as const;

interface DirtyBucket { chainId: number; tokenAddress: string; bucketStart: number }
interface CandleKey extends DirtyBucket { intervalSeconds: number }
type Row = Record<string, unknown>;

function key(row: DirtyBucket): string {
  return `${row.chainId}:${row.tokenAddress}:${row.bucketStart}`;
}

function affectedKeys(dirty: readonly DirtyBucket[], intervalSeconds: number): CandleKey[] {
  const byKey = new Map<string, CandleKey>();
  for (const row of dirty) {
    const item = { chainId: row.chainId, tokenAddress: row.tokenAddress,
      bucketStart: Math.floor(row.bucketStart / intervalSeconds) * intervalSeconds, intervalSeconds };
    byKey.set(key(item), item);
  }
  return [...byKey.values()];
}

function values(keys: readonly DirtyBucket[]): { placeholders: string; params: unknown[] } {
  const params: unknown[] = [];
  const placeholders = keys.map((row) => {
    const start = params.length;
    params.push(row.chainId, row.tokenAddress, row.bucketStart);
    return `($${start + 1}::int, $${start + 2}::text, $${start + 3}::int)`;
  }).join(',');
  return { placeholders, params };
}

function asTrade(row: Row): Trade {
  return {
    chainId: Number(row.chain_id), tokenAddress: String(row.token_address) as Address,
    venueId: String(row.venue_id), blockNumber: BigInt(String(row.block_number)),
    blockHash: String(row.block_hash) as Hash, txHash: String(row.tx_hash) as Hash,
    logIndex: Number(row.log_index), timestamp: Number(row.timestamp), side: String(row.side) as Trade['side'],
    tokenAmountRaw: BigInt(String(row.token_amount_raw)), quoteAmountRaw: BigInt(String(row.quote_amount_raw)),
    quoteAssetAddress: String(row.quote_asset_address) as Address, sourceEvent: String(row.source_event),
    activityKind: String(row.activity_kind) as Trade['activityKind'],
    priceNumeratorRaw: row.price_numerator_raw === null ? null : BigInt(String(row.price_numerator_raw)),
    priceDenominatorRaw: row.price_denominator_raw === null ? null : BigInt(String(row.price_denominator_raw)),
    traderAddress: String(row.trader_address) as Address,
  };
}

async function rebuildInterval(client: PoolClient, dirty: readonly DirtyBucket[], intervalSeconds: number): Promise<void> {
  const keys = affectedKeys(dirty, intervalSeconds);
  const { placeholders, params } = values(keys);
  // One bounded query for the keys claimed in this transaction. Non-official trades never enter
  // the cache. A missing canonical trade leaves no candle, including after a reorg deletion.
  const result = await client.query(`WITH affected(chain_id, token_address, bucket_start) AS (VALUES ${placeholders})
    SELECT a.bucket_start AS affected_bucket, t.*, l.quote_asset_address AS launch_quote_asset_address
    FROM affected a
    JOIN trades t ON t.chain_id = a.chain_id AND t.token_address = a.token_address
      AND t.timestamp >= a.bucket_start AND t.timestamp < a.bucket_start + $${params.length + 1}::int
    JOIN venues v ON v.id = t.venue_id AND v.official = true
    JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
    ORDER BY t.chain_id, t.token_address, a.bucket_start, t.block_number, t.log_index`,
  [...params, intervalSeconds]);
  const byKey = new Map<string, Row[]>();
  for (const row of result.rows as Row[]) {
    const item = { chainId: Number(row.chain_id), tokenAddress: String(row.token_address),
      bucketStart: Number(row.affected_bucket) };
    const group = byKey.get(key(item)) ?? [];
    group.push(row);
    byKey.set(key(item), group);
  }

  const candles: Candle[] = [];
  const unpricedKeys: DirtyBucket[] = [];
  for (const item of keys) {
    const rows = byKey.get(key(item)) ?? [];
    if (rows.length === 0) continue;
    const trades = rows.map(asTrade);
    if (intervalSeconds === 60 && trades.some((trade) => trade.priceNumeratorRaw === null || trade.priceDenominatorRaw === null)) {
      unpricedKeys.push(item);
    }
    const built = buildOfficialCandles(trades, intervalSeconds, {
      chainId: item.chainId, tokenAddress: item.tokenAddress as Address,
      quoteAssetAddress: String(rows[0]!.launch_quote_asset_address) as Address,
      venueIds: new Set(rows.map((row) => String(row.venue_id))), complete: true,
    });
    if (built[0]) candles.push(built[0]);
  }

  await client.query(`WITH affected(chain_id, token_address, bucket_start) AS (VALUES ${placeholders})
    DELETE FROM candles c USING affected a
    WHERE c.chain_id = a.chain_id AND c.token_address = a.token_address
      AND c.bucket_start = a.bucket_start AND c.interval_seconds = $${params.length + 1}::int`,
  [...params, intervalSeconds]);
  if (intervalSeconds === 60) {
    await client.query(`WITH affected(chain_id, token_address, bucket_start) AS (VALUES ${placeholders})
      DELETE FROM candle_unpriced_buckets u USING affected a
      WHERE u.chain_id = a.chain_id AND u.token_address = a.token_address AND u.bucket_start = a.bucket_start`, params);
    if (unpricedKeys.length > 0) {
      const unpriced = values(unpricedKeys);
      await client.query(`INSERT INTO candle_unpriced_buckets (chain_id, token_address, bucket_start)
        VALUES ${unpriced.placeholders}`, unpriced.params);
    }
  }
  if (candles.length === 0) return;
  const insertParams: unknown[] = [];
  const insertValues = candles.map((candle) => {
    const start = insertParams.length;
    insertParams.push(candle.chainId, candle.tokenAddress, candle.intervalSeconds, candle.bucketStart,
      candle.open, candle.high, candle.low, candle.close, candle.quoteVolumeRaw.toString());
    return `(${Array.from({ length: 9 }, (_, i) => `$${start + i + 1}`).join(',')})`;
  }).join(',');
  await client.query(`INSERT INTO candles (chain_id, token_address, interval_seconds, bucket_start,
    open, high, low, close, quote_volume_raw) VALUES ${insertValues}`, insertParams);
}

/** Rebuild at most `limit` distinct minute buckets atomically; safe to retry after any crash. */
// Newest buckets first: they are the ones a page is showing, and they are cheap (few trades); the old ones a price-round backfill marks dirty can each
// mean rebuilding 100k trades and must not hold a live trade's candle back. Every bucket is still rebuilt.
export async function refreshDirtyCandles(pool: Pool, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid candle refresh limit');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(`SELECT chain_id, token_address, bucket_start
      FROM candle_dirty_buckets ORDER BY bucket_start DESC, chain_id, token_address
      LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    const dirty: DirtyBucket[] = (selected.rows as Row[]).map((row) => ({
      chainId: Number(row.chain_id), tokenAddress: String(row.token_address), bucketStart: Number(row.bucket_start),
    }));
    if (dirty.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    // The `candles` table is read only once its backfill has started (candle_cache_state has a row); before that nothing looks at it, and keeping it
    // current means re-reading a token's whole day of trades for every dirty minute (50,000 disk reads for 35 dirty minutes on the dev database),
    // which kept the USD candles the chart does read waiting for minutes.
    const legacyCandlesInUse = (await client.query('SELECT 1 FROM candle_cache_state WHERE id = 1')).rows.length > 0;
    if (legacyCandlesInUse) for (const intervalSeconds of CANDLE_INTERVALS) await rebuildInterval(client, dirty, intervalSeconds);
    await rebuildLaunchVolume(client, dirty);
    await rebuildUsdCandles(client, dirty);
    const { placeholders, params } = values(dirty);
    await client.query(`WITH completed(chain_id, token_address, bucket_start) AS (VALUES ${placeholders})
      DELETE FROM candle_dirty_buckets d USING completed c
      WHERE d.chain_id = c.chain_id AND d.token_address = c.token_address AND d.bucket_start = c.bucket_start`, params);
    await announceRecentCandleChanges(client, dirty);
    await client.query('COMMIT');
    return dirty.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Only buckets from the last couple of hours are live activity worth telling browsers about; a backfill re-dirties old buckets by the
// thousand and must not flood the event stream. NOTIFY is delivered when this transaction commits, i.e. once the candles are readable.
const LIVE_CANDLE_WINDOW_SECONDS = 2 * 60 * 60;
async function announceRecentCandleChanges(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, dirty: readonly DirtyBucket[]): Promise<void> {
  const recentAfter = Math.floor(Date.now() / 1000) - LIVE_CANDLE_WINDOW_SECONDS;
  const launches = new Map<string, DirtyBucket>();
  for (const bucket of dirty) if (bucket.bucketStart >= recentAfter) launches.set(`${bucket.chainId}:${bucket.tokenAddress.toLowerCase()}`, bucket);
  for (const bucket of launches.values()) {
    await client.query('SELECT pg_notify($1, $2)', ['launchpad_events',
      JSON.stringify({ type: 'launch.changed', chainId: bucket.chainId, tokenAddress: bucket.tokenAddress.toLowerCase() })]);
  }
}
