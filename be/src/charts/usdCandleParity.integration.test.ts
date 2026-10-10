import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { refreshUsdCandles } from '../market/usdCandleStore.js';
import { rebuildUsdCandles } from './usdCandleRollup.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 990006;
const source = 'usd-parity-test-src';
const token = `0x${'b1'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const feed = `0x${'b2'.repeat(20)}`;
const venues = [['usd-parity-curve', 'curve'], ['usd-parity-v4', 'v4_pool']] as const;
const start = 1_800_000_040 - (1_800_000_040 % 86_400) + 20 * 3600; // 20:00 UTC, so the test spans midnight
const e18 = 10n ** 18n;
const INTERVALS = [60, 300, 3600, 14_400, 86_400];

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,$2,'v2',$3,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'b3'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1,$2,$3,'Parity','PAR',18,'pons','v2',$2,$2,100,$4,0,$5,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'b4'.repeat(32)}`, quote]);
  for (const [id, kind] of venues) {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,$4,$3,$5,1,true) ON CONFLICT DO NOTHING`, [id, chainId, token, kind, source]);
  }
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  // ETH price moves over time: $2 from block 1000, $3 from block 2000, $2.5 from block 3000 (8 decimals).
  for (const [round, block, answer] of [[1, 1000, 200_000_000], [2, 2000, 300_000_000], [3, 3000, 250_000_000]]) {
    await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
      VALUES ($1,$2,$3,$4,8,$5,$5,$6,0) ON CONFLICT DO NOTHING`, [chainId, feed, round, answer, start - 600, block]);
  }
  // 5 hours of trades spread over two venues, at varying minutes; one block before the first round makes its minute unpriced.
  let block = 1001;
  for (let minuteIndex = 0; minuteIndex < 300; minuteIndex += 7) {
    const ts = start + minuteIndex * 60 + (minuteIndex % 50);
    const unpriced = minuteIndex === 126;
    const venue = venues[minuteIndex % 2]![0];
    const useBlock = unpriced ? 900 : block + minuteIndex * 10;
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'buy',$9,$10,$11,'Swap','user_trade',$2)`,
    [chainId, token, venue, useBlock, `0x${String(useBlock).padStart(64, '0')}`, `0x${String(chainId)}${String(minuteIndex).padStart(58, '0')}`, minuteIndex % 3, ts,
      ((1n + BigInt(minuteIndex % 5)) * e18).toString(), ((1n + BigInt(minuteIndex % 9)) * e18 / 4n).toString(), quote]);
    block += 1;
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM usd_candles WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM trades WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM candle_dirty_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM launch_usd_candle_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('USD candle parity: incremental rollup vs the full rebuild', () => {
  it('serves exactly the same candles for every interval', async () => {
    for (const interval of INTERVALS) await refreshUsdCandles(pool, chainId, token, interval);
    const minutes = (await pool.query(`SELECT DISTINCT (timestamp / 60) * 60 AS m FROM trades WHERE chain_id = $1 ORDER BY 1`, [chainId])).rows.map((row) => Number(row.m));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await rebuildUsdCandles(client, minutes.map((bucketStart) => ({ chainId, tokenAddress: token, bucketStart })));
      await client.query('COMMIT');
    } finally { client.release(); }

    for (const interval of INTERVALS) {
      const oldRows = (await pool.query(`SELECT bucket_start::bigint AS b, open, high, low, close, volume_usd, trade_count FROM usd_candles
        WHERE chain_id = $1 AND interval_seconds = $2 ORDER BY bucket_start`, [chainId, interval])).rows;
      const newRows = (await pool.query(`SELECT bucket_start::bigint AS b, open, high, low, close, volume_usd, trade_count FROM launch_usd_candle_buckets
        WHERE chain_id = $1 AND interval_seconds = $2 AND unpriced_count = 0 ORDER BY bucket_start`, [chainId, interval])).rows;
      expect(oldRows.length).toBeGreaterThan(0);
      expect(newRows.map((row) => Number(row.b))).toEqual(oldRows.map((row) => Number(row.b)));
      newRows.forEach((row, index) => {
        const old = oldRows[index]!;
        for (const field of ['open', 'high', 'low', 'close'] as const) expect(Number(row[field])).toBeCloseTo(Number(old[field]), 10);
        expect(Number(row.volume_usd)).toBeCloseTo(Number(old.volume_usd), 5);
        expect(row.trade_count).toBe(old.trade_count);
      });
    }
    // the unpriced minute is a gap in the old table and an unavailable bucket in the new one
    const unpriced = (await pool.query(`SELECT count(*)::int AS n FROM launch_usd_candle_buckets WHERE chain_id = $1 AND interval_seconds = 60 AND unpriced_count > 0`, [chainId])).rows[0].n;
    expect(unpriced).toBe(1);
  });
});
