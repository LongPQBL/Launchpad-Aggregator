import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { read52WeekHighLowUsd } from './candleStats.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const token = '0x5252525252525252525252525252525252525252';
const unpricedToken = '0x5353535353535353535353535353535353535353';
const now = 1_800_000_000;
const day = 86_400;

async function addDay(address: string, daysAgo: number, high: string, low: string, unpriced = 0) {
  await pool.query(`INSERT INTO launch_usd_candle_buckets (chain_id, token_address, interval_seconds, bucket_start, open, high, low, close, volume_usd, trade_count, unpriced_count)
    VALUES (4663, $1, 86400, $2, $3, $3, $4, $4, 1, 1, $5)`, [address, Math.floor(now / day) * day - daysAgo * day, high, low, unpriced]);
}

beforeAll(async () => {
  await addDay(token, 3, '0.00004', '0.00001');
  await addDay(token, 2, '0.00009', '0.00002');
  await addDay(token, 400, '5', '0.000001'); // older than 52 weeks: ignored
  await addDay(unpricedToken, 1, '0.5', '0.1', 2);
});
afterAll(async () => {
  await pool.query('DELETE FROM launch_usd_candle_buckets WHERE token_address = ANY($1)', [[token, unpricedToken]]);
  await pool.end();
});

it('reports the 52-week USD high and low from the daily candles of the last 52 weeks', async () => {
  const range = await read52WeekHighLowUsd(pool, 4663, token, now);
  expect(range.complete).toBe(true);
  expect(Number(range.high)).toBeCloseTo(0.00009, 12);
  expect(Number(range.low)).toBeCloseTo(0.00001, 12);
});

it('gives no range (never a number) when a day has an unpriced trade or there are no candles', async () => {
  expect(await read52WeekHighLowUsd(pool, 4663, unpricedToken, now)).toEqual({ high: null, low: null, complete: false });
  expect(await read52WeekHighLowUsd(pool, 4663, '0x5454545454545454545454545454545454545454', now)).toEqual({ high: null, low: null, complete: false });
});
