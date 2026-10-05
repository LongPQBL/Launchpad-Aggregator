import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../../db/client.js';
import { invalidateLaunchVolume, type LaunchKey } from './store.js';
import { refreshDueLaunchVolumes, sweepLaunchVolumes } from './worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool: drizzlePool } = createDatabase(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'worker-test-src';
const quote: `0x${string}` = `0x${'9a'.repeat(20)}`;
const feed: `0x${string}` = `0x${'9b'.repeat(20)}`;
const token: `0x${string}` = `0x${'9c'.repeat(20)}`;
const key: LaunchKey = { chainId, tokenAddress: token };
const windowEnd = 1_800_000_000;
const now = new Date(windowEnd * 1000);
const headAtCompletion = async () => 4_000n;

async function jobRow() {
  return (await pool.query('SELECT revision, due_at, lease_id FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0];
}

async function scoreRow() {
  return (await pool.query('SELECT volume_usd, rank_category, completeness_reason, next_expiry_at FROM launch_volume24h_usd WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0];
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, 5000, 5000, 'caught_up'), ('worker-test-src-trades', $2, 'v1', $3, 0, 5000, 5000, 'caught_up')
    ON CONFLICT (id) DO UPDATE SET confirmed_to_block = 5000, scanned_to_block = 5000, status = 'caught_up'`,
  [source, chainId, `0x${'a1'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'Worker', 'WRK', 18, 'pons', 'v1', $2, $2, 100, $4, 1, $5, 'WETH', 18, 'trading')
    ON CONFLICT DO NOTHING`, [chainId, token, source, `0x${'b1'.repeat(32)}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ('worker-test-venue', $1, $2, 'v3_pool', $2, $3, 1, true) ON CONFLICT DO NOTHING`, [chainId, token, source]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'test', 'verified', now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1, $2, 1, 150000000, 8, $3, $3, 500, 0) ON CONFLICT DO NOTHING`, [chainId, feed, windowEnd - 200]);
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1, $2, 'worker-test-venue', 600, $3, $4, 1, $5, 'buy', '1', '2000000000000000000', $6, 'Swap', 'user_trade', $2)
    ON CONFLICT DO NOTHING`, [chainId, token, `0x${'b2'.repeat(32)}`, `0x${'b3'.repeat(32)}`, windowEnd - 100, quote]);
});

beforeEach(async () => {
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM launch_volume24h_usd WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE id = $1', ['worker-test-venue']);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[source, `${source}-trades`]]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, quote]);
  await drizzlePool.end();
  await pool.end();
});

describe('refreshDueLaunchVolumes', () => {
  it('publishes a due launch from its official trades and schedules its next expiry', async () => {
    await invalidateLaunchVolume(db, [key], new Date(now.getTime() - 1_000));

    const report = await refreshDueLaunchVolumes(pool, now, 10, headAtCompletion);

    expect(report).toMatchObject({ claimed: 1, published: 1, superseded: 0, failed: 0 });
    expect(await scoreRow()).toMatchObject({ rank_category: 'positive', completeness_reason: 'complete' });
    expect(Number((await scoreRow()).volume_usd)).toBeCloseTo(3);
    expect(new Date((await jobRow()).due_at).getTime()).toBe((windowEnd - 100 + 86_401) * 1000);
    expect(await jobRow()).toMatchObject({ lease_id: null });
  });

  it('schedules the expiry of the earliest trade, and that expiry removes it from the total with no new trade', async () => {
    await invalidateLaunchVolume(db, [key], new Date(now.getTime() - 1_000));
    await refreshDueLaunchVolumes(pool, now, 10, headAtCompletion);

    const expiry = new Date((windowEnd - 100 + 86_401) * 1000);
    expect(new Date((await jobRow()).due_at).getTime()).toBe(expiry.getTime());
    await refreshDueLaunchVolumes(pool, new Date(expiry.getTime() - 1_000), 10, headAtCompletion);
    expect(await jobRow()).toMatchObject({ lease_id: null });

    await refreshDueLaunchVolumes(pool, expiry, 10, headAtCompletion);
    expect(await scoreRow()).toMatchObject({ rank_category: 'zero', next_expiry_at: null });
    expect(await jobRow()).toBeUndefined();
  });
});

describe('sweepLaunchVolumes', () => {
  it('re-enqueues an updating row whose job was lost, so it is not stuck unavailable', async () => {
    await invalidateLaunchVolume(db, [key], new Date(now.getTime() - 1_000));
    await refreshDueLaunchVolumes(pool, now, 10, headAtCompletion);
    await invalidateLaunchVolume(db, [key], now);
    await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    expect(await scoreRow()).toMatchObject({ completeness_reason: 'updating' });

    expect(await sweepLaunchVolumes(pool, now)).toBeGreaterThanOrEqual(1);
    await refreshDueLaunchVolumes(pool, now, 10, headAtCompletion);
    expect(await scoreRow()).toMatchObject({ rank_category: 'positive', completeness_reason: 'complete' });
  });

  it('re-enqueues a published row whose expiry has passed even when its scheduled job is missing', async () => {
    await invalidateLaunchVolume(db, [key], new Date(now.getTime() - 1_000));
    await refreshDueLaunchVolumes(pool, now, 10, headAtCompletion);
    await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);

    const afterExpiry = new Date((windowEnd - 100 + 86_401) * 1000);
    expect(await sweepLaunchVolumes(pool, afterExpiry)).toBeGreaterThanOrEqual(1);
    expect(await jobRow()).toMatchObject({ lease_id: null });
    await refreshDueLaunchVolumes(pool, afterExpiry, 10, headAtCompletion);
    expect(await scoreRow()).toMatchObject({ rank_category: 'zero' });
  });
});
