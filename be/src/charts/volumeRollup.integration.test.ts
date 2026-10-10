import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { rebuildLaunchVolume, rebuildPoolVolume, redirtyVolumeForPriceChange } from './volumeRollup.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 990003;
const source = 'volume-rollup-test-src';
const token = `0x${'e1'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const otherSide = `0x${'e2'.repeat(20)}`;
const feed = `0x${'e3'.repeat(20)}`;
const curveVenue = 'volume-rollup-test-curve';
const v4Venue = 'volume-rollup-test-v4';
const poolId = `0x${'e4'.repeat(32)}`;
const base = 1_800_000_000; // divisible by 86400? no — only by 60; day math below floors explicitly
const minute = Math.floor(base / 60) * 60;
const day = Math.floor(base / 86_400) * 86_400;
const e18 = 10n ** 18n;

async function rebuild(minutes: number[], kind: 'launch' | 'pool' = 'launch'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (kind === 'launch') await rebuildLaunchVolume(client, minutes.map((bucketStart) => ({ chainId, tokenAddress: token, bucketStart })));
    else await rebuildPoolVolume(client, minutes.map((bucketStart) => ({ chainId, protocol: 'uniswap_v4', poolId, bucketStart })));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function addTrade(venue: string, block: number, ts: number, quoteEth: bigint): Promise<string> {
  const tx = `0x${String(chainId)}${String(block).padStart(58, '0')}`;
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,$4,$5,$6,0,$7,'buy',$8,$9,$10,'Swap','user_trade',$2)`,
  [chainId, token, venue, block, `0x${String(block).padStart(64, '0')}`, tx, ts, e18.toString(), (quoteEth * e18).toString(), quote]);
  return tx;
}

async function launchRows(interval: number): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(`SELECT venue_kind, bucket_start::int, volume_usd, trade_count, unpriced_count FROM launch_volume_buckets
    WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = $3 ORDER BY venue_kind, bucket_start`, [chainId, token, interval])).rows;
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,$2,'v2',$3,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'e5'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version,
    factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1,$2,$3,'Vol rollup','VRL',18,'pons','v2',$2,$2,100,$4,0,$5,'ETH',18,'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, `0x${'e6'.repeat(32)}`, quote]);
  for (const [id, kind] of [[curveVenue, 'curve'], [v4Venue, 'v4_pool']]) {
    await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
      VALUES ($1,$2,$3,$4,$3,$5,1,true) ON CONFLICT DO NOTHING`, [id, chainId, token, kind, source]);
  }
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  // ETH = $2.00, updated 100 s before the first trade, at block 500.
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1,$2,1,200000000,8,$3,$3,500,0) ON CONFLICT DO NOTHING`, [chainId, feed, base - 100]);
  await pool.query(`INSERT INTO pool_catalog (chain_id, protocol, pool_id, currency0, currency1, fee, tick_spacing, hooks, block_number, block_hash, tx_hash, log_index, verified)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$3,100,$5,$5,0,true) ON CONFLICT DO NOTHING`, [chainId, poolId, quote, otherSide, `0x${'e7'.repeat(32)}`]);
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
  await pool.end();
});

describe('launch volume rollup', () => {
  it('values a minute, splits venue kinds, and rolls up to the day', async () => {
    await addTrade(curveVenue, 600, minute + 5, 1n);  // $2
    await addTrade(curveVenue, 601, minute + 20, 2n); // $4, same minute
    await addTrade(v4Venue, 602, minute + 130, 1n);   // $2, two minutes later
    await rebuild([minute, minute + 120]);
    expect(await launchRows(60)).toEqual([
      { venue_kind: 'curve', bucket_start: minute, volume_usd: '6.000000', trade_count: 2, unpriced_count: 0 },
      { venue_kind: 'v4_pool', bucket_start: minute + 120, volume_usd: '2.000000', trade_count: 1, unpriced_count: 0 },
    ]);
    const daily = await launchRows(86_400);
    expect(daily).toEqual([
      { venue_kind: 'curve', bucket_start: day, volume_usd: '6.000000', trade_count: 2, unpriced_count: 0 },
      { venue_kind: 'v4_pool', bucket_start: day, volume_usd: '2.000000', trade_count: 1, unpriced_count: 0 },
    ]);
    expect((await launchRows(14_400)).length).toBe(2);
  });

  it('counts a trade older than the first oracle round as unpriced', async () => {
    await addTrade(curveVenue, 300, minute + 300, 1n); // block 300 < round block 500
    await rebuild([minute + 300]);
    const row = (await launchRows(60)).find((r) => r.bucket_start === minute + 300);
    expect(row).toMatchObject({ trade_count: 1, unpriced_count: 1 });
    expect((await launchRows(86_400)).find((r) => r.venue_kind === 'curve')).toMatchObject({ trade_count: 3, unpriced_count: 1 });
  });

  it('removes minute and coarser buckets when the trades are deleted (reorg)', async () => {
    await pool.query('DELETE FROM trades WHERE chain_id = $1', [chainId]);
    await rebuild([minute, minute + 120, minute + 300]);
    for (const interval of [60, 300, 3600, 14_400, 86_400]) expect(await launchRows(interval)).toEqual([]);
  });

  it('re-queues recent minutes, but not old ones, when a new oracle round arrives', async () => {
    const recent = Math.floor(Date.now() / 1000) - 600;
    await addTrade(curveVenue, 700, recent, 1n);
    await addTrade(curveVenue, 701, 1_700_000_000, 1n); // years old: a fresh round cannot price it
    await pool.query('DELETE FROM candle_dirty_buckets WHERE chain_id = $1', [chainId]);
    const client = await pool.connect();
    try { await redirtyVolumeForPriceChange(client, { chainId, quoteAssetAddress: quote, fromBlock: 0n }); } finally { client.release(); }
    const dirty = await pool.query('SELECT bucket_start::int FROM candle_dirty_buckets WHERE chain_id = $1', [chainId]);
    expect(dirty.rows).toEqual([{ bucket_start: Math.floor(recent / 60) * 60 }]);
    await pool.query('DELETE FROM trades WHERE chain_id = $1', [chainId]);
  });
});

describe('pool volume rollup', () => {
  it('stores decimals-free USD for the side with a feed and marks the other side unpriced', async () => {
    const tx = `0x${'e8'.repeat(32)}`;
    await pool.query(`INSERT INTO pool_trades (chain_id, tx_hash, log_index, protocol, pool_id, block_number, block_hash, timestamp,
      amount0_raw, amount1_raw, sqrt_price_x96, trader_address, sender_address, fee)
      VALUES ($1,$2,0,'uniswap_v4',$3,600,$2,$4,$5,$6,$7,$8,$8,3000)`,
    [chainId, tx, poolId, minute + 5, (-e18).toString(), '5', (2n ** 96n).toString(), quote]);
    await rebuild([minute], 'pool');
    const rows = (await pool.query(`SELECT interval_seconds, bucket_start::int, trade_count, usd_scaled0, unpriced0, usd_scaled1, unpriced1
      FROM pool_volume_buckets WHERE chain_id = $1 ORDER BY interval_seconds`, [chainId])).rows;
    expect(rows.map((r) => r.interval_seconds)).toEqual([60, 300, 3600, 14_400, 86_400]);
    // |-1e18| * 200000000 / 10^8 = 2e18 (divide by 10^18 token decimals at read time => $2)
    expect(rows[0]).toMatchObject({ bucket_start: minute, trade_count: 1, unpriced0: 0, unpriced1: 1, usd_scaled1: null });
    expect(BigInt(String(rows[0].usd_scaled0).split('.')[0]!)).toBe(2n * e18);
    await pool.query('DELETE FROM pool_trades WHERE chain_id = $1', [chainId]);
    await rebuild([minute], 'pool');
    expect((await pool.query('SELECT 1 FROM pool_volume_buckets WHERE chain_id = $1', [chainId])).rowCount).toBe(0);
  });
});
