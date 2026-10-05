import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { refreshUsdCandles } from './usdCandleStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'usd-candle-test-src';
const token = `0x${'c5'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const feed = `0x${'c6'.repeat(20)}`;
const venueId = 'usd-candle-test-venue';
const base = 1_800_000_000; // divisible by 60, so buckets start on the minute
const e18 = 10n ** 18n;

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'c7'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'USD candle', 'USC', 18, 'pons', 'v2', $2, $2, 100, $4, 0, $5, 'ETH', 18, 'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'c8'.repeat(32)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $3, $4, 1, true) ON CONFLICT DO NOTHING`, [venueId, chainId, token, source]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'test', 'verified', now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  // ETH = $2.00 (answer 200000000 with 8 decimals), updated 100 seconds before the first trade.
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1, $2, 1, 200000000, 8, $3, $3, 500, 0) ON CONFLICT DO NOTHING`, [chainId, feed, base - 100]);
  const trade = async (block: number, log: number, ts: number, tokens: bigint, quoteEth: bigint) => {
    await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
      side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'buy', $9, $10, $11, 'Swap', 'user_trade', $2)`,
    [chainId, token, venueId, block, `0x${String(block).padStart(64, '0')}`, `0x${String(block * 10 + log).padStart(64, '0')}`, log, ts,
      (tokens * e18).toString(), (quoteEth * e18).toString(), quote]);
  };
  await trade(600, 1, base + 5, 1n, 1n);   // minute 1: price 2.00 USD per token
  await trade(601, 1, base + 20, 1n, 2n);  // minute 1: price 4.00 USD per token
  await trade(602, 1, base + 70, 2n, 1n);  // minute 2: price 1.00 USD per token
  await trade(300, 1, base + 130, 1n, 1n); // before the round's block: unpriced, so its minute is omitted
});

afterAll(async () => {
  await pool.query('DELETE FROM usd_candles WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, quote]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('refreshUsdCandles', () => {
  it('writes per-token USD OHLC and summed USD volume for each priced minute, and omits a minute with an unpriced trade', async () => {
    const written = await refreshUsdCandles(pool, chainId, token, 60);

    expect(written).toBe(2);
    const rows = (await pool.query('SELECT bucket_start, open, high, low, close, volume_usd, trade_count FROM usd_candles WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = 60 ORDER BY bucket_start', [chainId, token])).rows;
    expect(rows.map((row) => ({ bucket_start: Number(row.bucket_start), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume_usd: Number(row.volume_usd), trade_count: row.trade_count }))).toEqual([
      { bucket_start: base, open: 2, high: 4, low: 2, close: 4, volume_usd: 6, trade_count: 2 },
      { bucket_start: base + 60, open: 1, high: 1, low: 1, close: 1, volume_usd: 2, trade_count: 1 },
    ]);
  });

  it('replaces the stored rows on a second run instead of appending', async () => {
    await refreshUsdCandles(pool, chainId, token, 60);
    const count = (await pool.query('SELECT count(*)::int AS n FROM usd_candles WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = 60', [chainId, token])).rows[0].n;
    expect(count).toBe(2);
  });
});
