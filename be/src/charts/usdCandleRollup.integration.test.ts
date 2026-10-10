import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { rebuildUsdCandles } from './usdCandleRollup.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 990005;
const source = 'usd-rollup-test-src';
const token = `0x${'a1'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const feed = `0x${'a2'.repeat(20)}`;
const curveVenue = 'usd-rollup-test-curve';
const v4Venue = 'usd-rollup-test-v4';
const base = 1_800_000_000; // multiple of 60
const minute = Math.floor(base / 60) * 60;
const day = Math.floor(base / 86_400) * 86_400;
const e18 = 10n ** 18n;

async function rebuild(minutes: number[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await rebuildUsdCandles(client, minutes.map((bucketStart) => ({ chainId, tokenAddress: token, bucketStart })));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function addTrade(venue: string, block: number, log: number, ts: number, tokens: bigint, quoteEth: bigint): Promise<void> {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'buy',$9,$10,$11,'Swap','user_trade',$2)`,
  [chainId, token, venue, block, `0x${String(block).padStart(64, '0')}`, `0x${String(chainId)}${String(block * 10 + log).padStart(58, '0')}`, log, ts,
    (tokens * e18).toString(), (quoteEth * e18).toString(), quote]);
}

async function rows(interval: number): Promise<Array<Record<string, number>>> {
  const result = await pool.query(`SELECT bucket_start, open, high, low, close, volume_usd, trade_count, unpriced_count FROM launch_usd_candle_buckets
    WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = $3 ORDER BY bucket_start`, [chainId, token, interval]);
  return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? NaN : Number(value)])));
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,$2,'v2',$3,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'a3'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1,$2,$3,'USD rollup','URL',18,'pons','v2',$2,$2,100,$4,0,$5,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'a4'.repeat(32)}`, quote]);
  for (const [id, kind] of [[curveVenue, 'curve'], [v4Venue, 'v4_pool']]) {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,$4,$3,$5,1,true) ON CONFLICT DO NOTHING`, [id, chainId, token, kind, source]);
  }
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  // ETH = $2.00 from block 500 (8 decimals), updated 100 s before the first trade.
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1,$2,1,200000000,8,$3,$3,500,0) ON CONFLICT DO NOTHING`, [chainId, feed, base - 100]);
});

afterAll(async () => {
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

describe('USD candle rollup', () => {
  it('builds OHLC and volume for a priced minute, with open/close ordered across venues', async () => {
    await addTrade(v4Venue, 602, 1, minute + 30, 1n, 2n);   // $4/token, the later position
    await addTrade(curveVenue, 600, 1, minute + 5, 1n, 1n); // $2/token, the earlier position (other venue)
    await addTrade(curveVenue, 601, 1, minute + 20, 1n, 3n); // $6/token
    await rebuild([minute]);
    expect(await rows(60)).toEqual([{ bucket_start: minute, open: 2, high: 6, low: 2, close: 4, volume_usd: 12, trade_count: 3, unpriced_count: 0 }]);
  });

  it('derives every coarser bucket from the finer ones', async () => {
    await addTrade(curveVenue, 610, 1, minute + 3700, 2n, 1n); // an hour later, $1/token
    await rebuild([minute + 3660]);
    expect(await rows(3600)).toEqual([
      { bucket_start: Math.floor(minute / 3600) * 3600, open: 2, high: 6, low: 2, close: 4, volume_usd: 12, trade_count: 3, unpriced_count: 0 },
      { bucket_start: Math.floor((minute + 3700) / 3600) * 3600, open: 1, high: 1, low: 1, close: 1, volume_usd: 2, trade_count: 1, unpriced_count: 0 },
    ].sort((a, b) => a.bucket_start! - b.bucket_start!));
    const [daily] = await rows(86_400);
    // two hourly buckets can fall in one or two UTC days; the sums must cover both trades' volume either way
    const total = (await rows(86_400)).reduce((sum, row) => sum + row.volume_usd!, 0);
    expect(total).toBe(14);
    expect(daily!.bucket_start).toBe(day);
  });

  it('counts an unpriced or zero-amount trade, and the bucket is then not a readable candle', async () => {
    await addTrade(curveVenue, 300, 1, minute + 200, 1n, 1n); // before the oracle round: unpriced
    await rebuild([minute + 180]);
    expect((await rows(60)).find((row) => row.bucket_start === minute + 180)).toMatchObject({ trade_count: 1, unpriced_count: 1 });
    await pool.query("UPDATE trades SET token_amount_raw = 0 WHERE chain_id = $1 AND block_number = 600", [chainId]);
    await rebuild([minute]);
    expect((await rows(60)).find((row) => row.bucket_start === minute)).toMatchObject({ unpriced_count: 1 });
    expect((await rows(86_400))[0]).toMatchObject({ unpriced_count: 2 });
  });

  it('removes minute and coarser buckets when the trades are deleted (reorg)', async () => {
    await pool.query('DELETE FROM trades WHERE chain_id = $1', [chainId]);
    await rebuild([minute, minute + 180, minute + 3660]);
    for (const interval of [60, 300, 3600, 14_400, 86_400]) expect(await rows(interval)).toEqual([]);
  });
});
