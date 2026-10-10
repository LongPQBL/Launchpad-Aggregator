import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { backfillLaunchVolume, backfillPoolVolume } from './backfillVolume.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 990004;
const source = 'volume-backfill-test-src';
const token = `0x${'f1'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const other = `0x${'f2'.repeat(20)}`;
const feed = `0x${'f3'.repeat(20)}`;
const venue = 'volume-backfill-test-venue';
const poolId = `0x${'f4'.repeat(32)}`;
const minute = 1_800_000_000;
const e18 = 10n ** 18n;

beforeAll(async () => {
  await pool.query("DELETE FROM chart_rollup_state WHERE name IN ('launch_volume','pool_volume')");
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,$2,'v2',$3,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'f5'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1,$2,$3,'Backfill','BKF',18,'pons','v2',$2,$2,100,$4,0,$5,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'f6'.repeat(32)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1,$2,$3,'curve',$3,$4,1,true) ON CONFLICT DO NOTHING`, [venue, chainId, token, source]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1,$2,1,200000000,8,$3,$3,500,0) ON CONFLICT DO NOTHING`, [chainId, feed, minute - 100]);
  for (const [block, ts] of [[600, minute + 5], [601, minute + 3700]]) {
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7,'buy',$8,$8,$9,'Swap','user_trade',$2)`,
    [chainId, token, venue, block, `0x${String(block).padStart(64, '0')}`, `0x${'9'}${String(block).padStart(63, '0')}`, ts, e18.toString(), quote]);
  }
  await pool.query(`INSERT INTO pool_catalog (chain_id, protocol, pool_id, currency0, currency1, fee, tick_spacing, hooks, block_number, block_hash, tx_hash, log_index, verified)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$3,100,$5,$5,0,true) ON CONFLICT DO NOTHING`, [chainId, poolId, quote, other, `0x${'f7'.repeat(32)}`]);
  await pool.query(`INSERT INTO pool_trades (chain_id, tx_hash, log_index, protocol, pool_id, block_number, block_hash, timestamp,
    amount0_raw, amount1_raw, sqrt_price_x96, trader_address, sender_address, fee)
    VALUES ($1,$2,0,'uniswap_v4',$3,600,$2,$4,$5,'5',$6,$7,$7,3000)`, [chainId, `0x${'f8'.repeat(32)}`, poolId, minute + 5, e18.toString(), (2n ** 96n).toString(), quote]);
  // The live triggers queued these minutes; the backfill must not depend on that queue.
  await pool.query('DELETE FROM candle_dirty_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_candle_dirty_buckets WHERE chain_id = $1', [chainId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_trades WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM candle_dirty_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_candle_dirty_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM launch_volume_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_volume_buckets WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM venues WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.query("DELETE FROM chart_rollup_state WHERE name IN ('launch_volume','pool_volume')");
  await pool.end();
});

describe('volume bucket backfill', () => {
  it('rebuilds launch and pool buckets from trades, then resumes as a no-op', async () => {
    expect(await backfillLaunchVolume(pool)).toBeGreaterThan(0);
    expect(await backfillPoolVolume(pool)).toBeGreaterThan(0);
    const hourly = (await pool.query(`SELECT bucket_start::int, volume_usd, trade_count FROM launch_volume_buckets
      WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = 3600 ORDER BY bucket_start`, [chainId, token])).rows;
    // 1 ETH * $2 per trade, two trades an hour apart
    expect(hourly.map((row) => [row.trade_count, Number(row.volume_usd)])).toEqual([[1, 2], [1, 2]]);
    const poolDaily = await pool.query('SELECT trade_count FROM pool_volume_buckets WHERE chain_id = $1 AND interval_seconds = 86400', [chainId]);
    expect(poolDaily.rows).toEqual([{ trade_count: 1 }]);
    expect(await backfillLaunchVolume(pool)).toBe(0);
    expect(await backfillPoolVolume(pool)).toBe(0);
  });
});
