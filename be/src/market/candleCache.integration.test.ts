import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { refreshDirtyCandles } from './candleCache.js';
import { createApiStore } from '../api/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const token = '0x2929292929292929292929292929292929292929';
const quote = '0x0000000000000000000000000000000000000000';
const source = 'candle-cache-test';
const venue = `4663:curve:${token}`;
const base = 1_700_000_040;

async function addTrade(hashSuffix: string, timestamp: number, blockNumber: number, logIndex: number,
  numerator: string | null, amount = '1000000000000000000', venueId = venue): Promise<void> {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash,
    log_index, timestamp, side, token_amount_raw, quote_amount_raw, quote_asset_address,
    source_event, activity_kind, price_numerator_raw, price_denominator_raw, trader_address)
    VALUES (4663,$1,$2,$3,$4,$5,$6,$7,'buy','1000000000000000000',$8,$9,'CurveBuy','user_trade',$10,'1',$1)`,
  [token, venueId, blockNumber, `0x${'a'.repeat(64)}`, `0x${hashSuffix.repeat(64)}`, logIndex,
    timestamp, amount, quote, numerator]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block,
    scanned_to_block, confirmed_to_block, status) VALUES ($1,4663,'v2',$2,0,0,0,'backfilling')
    ON CONFLICT DO NOTHING`, [source, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals,
    platform, protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES (4663,$1,$2,'Candle test','CND',18,'pons','v2',$1,$1,1,$3,0,$4,'ETH',18,'trading')
    ON CONFLICT DO NOTHING`, [token, source, `0x${'f'.repeat(64)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id,
    effective_from_block, official) VALUES ($1,4663,$2,'curve',$2,$3,1,true)
    ON CONFLICT DO NOTHING`, [venue, token, source]);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE chain_id = 4663 AND token_address = $1', [token]);
  await pool.query('DELETE FROM candle_dirty_buckets WHERE chain_id = 4663 AND token_address = $1', [token]);
  await pool.query('DELETE FROM candle_unpriced_buckets WHERE chain_id = 4663 AND token_address = $1', [token]);
  await pool.query('DELETE FROM candles WHERE chain_id = 4663 AND token_address = $1', [token]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venue]);
  await pool.query('DELETE FROM launches WHERE chain_id = 4663 AND token_address = $1', [token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.query('DELETE FROM candle_cache_state WHERE id = 1');
  await pool.end();
});

describe('precomputed official candles', () => {
  it('rebuilds every supported interval in chain order, then repairs reorg deletion', async () => {
    await addTrade('1', base, 10, 2, '2');
    await addTrade('2', base + 1, 10, 3, '4');
    expect((await pool.query('SELECT count(*)::int AS n FROM candle_dirty_buckets WHERE token_address = $1', [token])).rows[0].n).toBe(1);
    await refreshDirtyCandles(pool, 1000);
    const rows = (await pool.query('SELECT interval_seconds, open, high, low, close, quote_volume_raw FROM candles WHERE token_address = $1 ORDER BY interval_seconds', [token])).rows;
    expect(rows.map((row) => row.interval_seconds)).toEqual([60, 300, 900, 3600, 86400]);
    expect(rows[0]).toMatchObject({ open: '2', high: '4', low: '2', close: '4', quote_volume_raw: '2000000000000000000' });
    await pool.query('DELETE FROM trades WHERE chain_id = 4663 AND tx_hash = $1', [`0x${'2'.repeat(64)}`]);
    await refreshDirtyCandles(pool, 1000);
    const repaired = (await pool.query('SELECT open, high, low, close, quote_volume_raw FROM candles WHERE token_address = $1 AND interval_seconds = 60', [token])).rows[0];
    expect(repaired).toMatchObject({ open: '2', high: '2', low: '2', close: '2', quote_volume_raw: '1000000000000000000' });
    await pool.query('INSERT INTO candle_cache_state (id, backfill_complete) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET backfill_complete = true');
    const store = createApiStore(pool);
    const ready = await store.listCandles(4663, token, 60, base + 60);
    expect(ready.items).toMatchObject([{ open: '2', close: '2', quoteVolume: '1' }]);
    await addTrade('4', base + 2, 11, 0, '8');
    const pending = await store.listCandles(4663, token, 60, base + 60);
    expect(pending.items).toEqual([]);
    expect(pending.complete).toBe(false);
    await refreshDirtyCandles(pool, 1000);
    const updated = await store.listCandles(4663, token, 60, base + 60);
    expect(updated.items).toMatchObject([{ open: '2', close: '8', high: '8', quoteVolume: '2' }]);
    const otherVenue = `4663:curve:other:${token}`;
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id,
      effective_from_block, official) VALUES ($1,4663,$2,'curve',$2,$3,1,false)`, [otherVenue, token, source]);
    await addTrade('5', base + 3, 11, 1, '100', '9000000000000000000', otherVenue);
    await refreshDirtyCandles(pool, 1000);
    const afterOtherPool = await store.listCandles(4663, token, 60, base + 60);
    expect(afterOtherPool.items).toEqual(updated.items);
  });

  it('omits a bucket with an unpriced trade', async () => {
    await addTrade('3', base + 120, 12, 0, null);
    await refreshDirtyCandles(pool, 1000);
    const bucket = Math.floor((base + 120) / 60) * 60;
    const rows = await pool.query('SELECT * FROM candles WHERE token_address = $1 AND interval_seconds = 60 AND bucket_start = $2', [token, bucket]);
    expect(rows.rowCount).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM candle_unpriced_buckets WHERE token_address = $1 AND bucket_start = $2', [token, bucket])).rows[0].n).toBe(1);
    const page = await createApiStore(pool).listCandles(4663, token, 60, bucket + 60);
    expect(page.complete).toBe(false);
    expect(page.items.some((item) => item.bucketStart === bucket)).toBe(false);
  });
});
