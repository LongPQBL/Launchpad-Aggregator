import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { countMissingLaunchVolumes, reconcileLaunchVolumes, runVolumeBackfill } from './backfill.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'backfill-test-src';
const quote: `0x${string}` = `0x${'ab'.repeat(20)}`;
const feed: `0x${string}` = `0x${'ac'.repeat(20)}`;
const now = new Date('2026-10-05T12:00:00Z');
const windowEnd = Math.floor(now.getTime() / 1000);
const head = async () => 4_000n;
const tokens = { priced: `0x${'d1'.repeat(20)}`, zero: `0x${'d2'.repeat(20)}`, unpriced: `0x${'d3'.repeat(20)}`, late: `0x${'d4'.repeat(20)}` };
const allTokens = Object.values(tokens);

async function insertLaunch(token: string, block: number): Promise<void> {
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'Backfill', 'BKF', 18, 'pons', 'v1', $2, $2, $4, $5, 1, $6, 'WETH', 18, 'trading')`,
  [chainId, token, source, block, `0x${String(block).padStart(64, '0')}`, quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'v3_pool', $3, $4, 1, true)`, [`backfill-venue-${token}`, chainId, token, source]);
}

async function addTrade(token: string, block: number, timestamp: number, tag: number): Promise<void> {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'buy', '1', '2000000000000000000', $8, 'Swap', 'user_trade', $2)`,
  [chainId, token, `backfill-venue-${token}`, block, `0x${String(tag).padStart(64, '0')}`, `0x${String(tag + 1).padStart(64, '0')}`,
    timestamp, quote]);
}

async function scoreOf(token: string) {
  return (await pool.query('SELECT volume_usd, rank_category, completeness_reason, computed_at FROM launch_volume24h_usd WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0];
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, 5000, 5000, 'caught_up'), ($1 || '-trades', $2, 'v1', $3, 0, 5000, 5000, 'caught_up')
    ON CONFLICT (id) DO UPDATE SET confirmed_to_block = 5000, scanned_to_block = 5000, status = 'caught_up'`,
  [source, chainId, `0x${'ae'.repeat(20)}`]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1, $2, $3, 'test', 'verified', now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`,
  [chainId, quote, feed]);
  await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id, feed_address, round_id, answer_raw, decimals, started_at, updated_at, block_number, log_index)
    VALUES ($1, $2, 1, 150000000, 8, $3, $3, 500, 0) ON CONFLICT DO NOTHING`, [chainId, feed, windowEnd - 200]);
  await insertLaunch(tokens.priced, 100);
  await insertLaunch(tokens.zero, 110);
  await insertLaunch(tokens.unpriced, 120);
  await addTrade(tokens.priced, 600, windowEnd - 100, 0xa1);
  await addTrade(tokens.unpriced, 300, windowEnd - 100, 0xb1);
});

beforeEach(async () => {
  await pool.query('DELETE FROM launch_volume24h_usd WHERE token_address = ANY($1)', [allTokens]);
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE token_address = ANY($1)', [allTokens]);
  await pool.query('DELETE FROM launch_volume24h_state WHERE id = 1');
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, allTokens]);
  await pool.query('DELETE FROM venues WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, allTokens]);
  await pool.query('DELETE FROM launch_volume24h_usd WHERE token_address = ANY($1)', [allTokens]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, allTokens]);
  await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[source, `${source}-trades`]]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, quote]);
  await pool.query('DELETE FROM launch_volume24h_state WHERE id = 1');
  await pool.end();
});

describe('runVolumeBackfill', () => {
  it('scores every launch and marks the backfill complete only once none is missing', async () => {
    const result = await runVolumeBackfill(pool, { now, batchSize: 10, readHead: head });

    expect(result.complete).toBe(true);
    expect(await countMissingLaunchVolumes(pool)).toBe(0);
    expect(await scoreOf(tokens.priced)).toMatchObject({ rank_category: 'positive', completeness_reason: 'complete' });
    expect(Number((await scoreOf(tokens.priced)).volume_usd)).toBeCloseTo(3);
    expect(await scoreOf(tokens.zero)).toMatchObject({ rank_category: 'zero' });
    expect(Number((await scoreOf(tokens.zero)).volume_usd)).toBe(0);
    expect(await scoreOf(tokens.unpriced)).toMatchObject({ volume_usd: null, rank_category: 'null', completeness_reason: 'unpriced_trade' });
    expect((await pool.query('SELECT backfill_complete_at FROM launch_volume24h_state WHERE id = 1')).rows[0].backfill_complete_at).not.toBeNull();
  });

  it('resumes an interrupted run without rescoring the launches it already finished', async () => {
    const partial = await runVolumeBackfill(pool, { now, batchSize: 1, maxIterations: 1, readHead: head });
    expect(partial.complete).toBe(false);
    const firstScored = (await pool.query('SELECT token_address, computed_at FROM launch_volume24h_usd WHERE token_address = ANY($1)', [allTokens])).rows;
    expect(firstScored).toHaveLength(1);

    const later = new Date(now.getTime() + 5_000);
    const resumed = await runVolumeBackfill(pool, { now: later, batchSize: 10, readHead: head });

    expect(resumed.complete).toBe(true);
    const after = (await pool.query('SELECT computed_at FROM launch_volume24h_usd WHERE token_address = $1', [firstScored[0].token_address])).rows[0];
    expect(new Date(after.computed_at).getTime()).toBe(new Date(firstScored[0].computed_at).getTime());
  });

  it('scores a launch that arrives after the backfill completed on the next pass, before it is ranked', async () => {
    await runVolumeBackfill(pool, { now, batchSize: 10, readHead: head });
    await insertLaunch(tokens.late, 130);
    expect(await countMissingLaunchVolumes(pool)).toBe(1);

    const result = await runVolumeBackfill(pool, { now, batchSize: 10, readHead: head });

    expect(result.complete).toBe(true);
    expect(await scoreOf(tokens.late)).toMatchObject({ rank_category: 'zero' });
  });

  it('leaves the backfill incomplete and no lease behind when the head read fails, then completes on retry', async () => {
    await expect(runVolumeBackfill(pool, { now, batchSize: 10, readHead: async () => { throw new Error('rpc down'); } })).rejects.toThrow('rpc down');
    expect((await pool.query('SELECT count(*)::int AS n FROM launch_volume24h_jobs WHERE lease_id IS NOT NULL AND token_address = ANY($1)', [allTokens])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT backfill_complete_at FROM launch_volume24h_state WHERE id = 1')).rows[0]?.backfill_complete_at ?? null).toBeNull();

    expect((await runVolumeBackfill(pool, { now, batchSize: 10, readHead: head })).complete).toBe(true);
  });
});

describe('reconcileLaunchVolumes', () => {
  it('agrees with the trade-page valuation for sampled launches, and flags a stored value that was tampered with', async () => {
    await runVolumeBackfill(pool, { now, batchSize: 10, readHead: head });

    const clean = await reconcileLaunchVolumes(pool, { sampleSize: 10, now });
    expect(clean.mismatches).toEqual([]);
    expect(clean.checked).toBeGreaterThanOrEqual(3);

    await pool.query("UPDATE launch_volume24h_usd SET volume_usd = 999 WHERE token_address = $1", [tokens.priced]);
    const tampered = await reconcileLaunchVolumes(pool, { sampleSize: 10, now });
    expect(tampered.mismatches).toEqual([expect.objectContaining({ tokenAddress: tokens.priced })]);
  });
});
