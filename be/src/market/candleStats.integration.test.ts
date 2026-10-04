import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { read52WeekHighLowFromCandles } from './candleStats.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const token = '0x3030303030303030303030303030303030303030';
const nowSeconds = 1_800_000_125;
const since = nowSeconds - 52 * 7 * 86400;
const firstFullDay = Math.ceil(since / 86400) * 86400;
const lastFullDay = Math.floor(nowSeconds / 86400) * 86400;

async function addCandle(interval: number, bucket: number, high: string, low: string): Promise<void> {
  await pool.query(`INSERT INTO candles (chain_id, token_address, interval_seconds, bucket_start,
    open, high, low, close, quote_volume_raw) VALUES (4663,$1,$2,$3,$4,$5,$6,$4,1)
    ON CONFLICT (chain_id, token_address, interval_seconds, bucket_start)
    DO UPDATE SET high = EXCLUDED.high, low = EXCLUDED.low`, [token, interval, bucket, low, high, low]);
}

afterAll(async () => {
  await pool.query('DELETE FROM candle_dirty_buckets WHERE token_address = $1', [token]);
  await pool.query('DELETE FROM candle_unpriced_buckets WHERE token_address = $1', [token]);
  await pool.query('DELETE FROM candles WHERE token_address = $1', [token]);
  await pool.end();
});

describe('52-week high/low from persisted candles', () => {
  it('uses day candles for full days and minute candles at both edges, with exact decimal ordering', async () => {
    await addCandle(60, Math.floor(since / 60) * 60, '0.03', '0.000000000000000001');
    await addCandle(86400, firstFullDay, '2', '0.5');
    await addCandle(86400, lastFullDay - 86400, '12', '0.25');
    await addCandle(60, lastFullDay, '3', '1');
    await addCandle(86400, firstFullDay - 86400, '1000', '0.0000000000000000001');
    expect(await read52WeekHighLowFromCandles(pool, 4663, token, nowSeconds)).toEqual({
      high: '12', low: '0.000000000000000001', complete: true,
    });
  });

  it('returns no extrema while a covered minute is dirty or contains an unpriced trade', async () => {
    const bucket = lastFullDay;
    await pool.query(`INSERT INTO candle_dirty_buckets VALUES (4663,$1,$2) ON CONFLICT DO NOTHING`, [token, bucket]);
    expect((await read52WeekHighLowFromCandles(pool, 4663, token, nowSeconds)).complete).toBe(false);
    await pool.query('DELETE FROM candle_dirty_buckets WHERE token_address = $1', [token]);
    await pool.query(`INSERT INTO candle_unpriced_buckets VALUES (4663,$1,$2) ON CONFLICT DO NOTHING`, [token, bucket]);
    expect(await read52WeekHighLowFromCandles(pool, 4663, token, nowSeconds)).toEqual({
      high: null, low: null, complete: false,
    });
  });
});
