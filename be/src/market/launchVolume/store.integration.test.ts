import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { claimVolumeJobs, invalidateLaunchVolume, publishVolumeScore, type LaunchKey, type VolumeScore } from './store.js';
import { createDatabase } from '../../db/client.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const { db, pool: drizzlePool } = createDatabase(databaseUrl);
const source = 'launch-volume-store-test';
const tokenA = `0x${'51'.repeat(20)}`;
const tokenB = `0x${'52'.repeat(20)}`;
const keyA: LaunchKey = { chainId: 4663, tokenAddress: tokenA };
const keyB: LaunchKey = { chainId: 4663, tokenAddress: tokenB };
const now = new Date('2026-10-05T12:00:00Z');
const tokens = [tokenA, tokenB];

function scoreFor(volumeUsd: string | null, rankCategory: VolumeScore['rankCategory']): VolumeScore {
  return {
    volumeUsd, rankCategory, computedAt: now, windowEnd: Math.floor(now.getTime() / 1000),
    nextExpiryAt: null, completenessReason: 'complete', launchBlock: 100n, launchTxHash: `0x${'a'.repeat(64)}`, launchLogIndex: 1,
  };
}

async function jobRow(token: string) {
  return (await pool.query('SELECT revision, due_at, lease_id, lease_until FROM launch_volume24h_jobs WHERE chain_id = 4663 AND token_address = $1', [token])).rows[0];
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block,
    scanned_to_block, confirmed_to_block, status) VALUES ($1,4663,'v2',$2,0,0,0,'backfilling')
    ON CONFLICT DO NOTHING`, [source, tokenA]);
  for (const token of tokens) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals,
      platform, protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES (4663,$1,$2,'Volume store test','VST',18,'pons','v2',$1,$1,100,$3,1,$1,'ETH',18,'trading')
      ON CONFLICT DO NOTHING`, [token, source, `0x${'a'.repeat(64)}`]);
  }
});

beforeEach(async () => {
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM launch_volume24h_usd WHERE token_address = ANY($1)', [tokens]);
});

afterAll(async () => {
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM launch_volume24h_usd WHERE token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM launches WHERE chain_id = 4663 AND token_address = ANY($1)', [tokens]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await drizzlePool.end();
  await pool.end();
});

describe('launch volume store', () => {
  it('coalesces repeated invalidations into one job and increments revision once per call', async () => {
    await invalidateLaunchVolume(db, [keyA, keyA], new Date(now.getTime() + 60_000));
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() + 60_000));
    const rows = await pool.query('SELECT count(*)::int AS n FROM launch_volume24h_jobs WHERE token_address = $1', [tokenA]);
    expect(rows.rows[0].n).toBe(1);
    expect((await jobRow(tokenA)).revision).toBe(2);
  });

  it('moves a due time earlier but never later', async () => {
    const early = new Date(now.getTime() + 10_000);
    const late = new Date(now.getTime() + 500_000);
    await invalidateLaunchVolume(db, [keyA], late);
    await invalidateLaunchVolume(db, [keyA], early);
    expect(new Date((await jobRow(tokenA)).due_at).getTime()).toBe(early.getTime());
    await invalidateLaunchVolume(db, [keyA], late);
    expect(new Date((await jobRow(tokenA)).due_at).getTime()).toBe(early.getTime());
  });

  it('hands each due job to exactly one of two concurrent claims', async () => {
    await invalidateLaunchVolume(db, [keyA, keyB], new Date(now.getTime() - 1_000));
    const [first, second] = await Promise.all([claimVolumeJobs(pool, now, 10), claimVolumeJobs(pool, now, 10)]);
    const claimed = [...first, ...second].map((claim) => `${claim.key.chainId}:${claim.key.tokenAddress}`).sort();
    expect(claimed).toEqual([`4663:${tokenA}`, `4663:${tokenB}`].sort());
    expect(new Set(claimed).size).toBe(2);
  });

  it('reclaims a job whose lease has expired and issues a new lease id', async () => {
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() - 1_000));
    const [firstClaim] = await claimVolumeJobs(pool, now, 1);
    await pool.query("UPDATE launch_volume24h_jobs SET lease_until = $2 WHERE token_address = $1", [tokenA, new Date(now.getTime() - 1_000)]);
    const [secondClaim] = await claimVolumeJobs(pool, now, 1);
    expect(secondClaim.key.tokenAddress).toBe(tokenA);
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
  });

  it('rejects a publish from a superseded revision and keeps the newer job queued', async () => {
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() - 1_000));
    const [claim] = await claimVolumeJobs(pool, now, 1);
    await invalidateLaunchVolume(db, [keyA], now);
    expect(await publishVolumeScore(pool, claim, scoreFor('5', 'positive'))).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM launch_volume24h_usd WHERE token_address = $1', [tokenA])).rows[0].n).toBe(0);
    expect((await jobRow(tokenA)).revision).toBe(2);
  });

  it('publishes the claimed revision and removes the job', async () => {
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() - 1_000));
    const [claim] = await claimVolumeJobs(pool, now, 1);
    expect(await publishVolumeScore(pool, claim, scoreFor('5', 'positive'))).toBe(true);
    const score = (await pool.query('SELECT volume_usd, rank_category, rank_order, revision FROM launch_volume24h_usd WHERE token_address = $1', [tokenA])).rows[0];
    expect(score).toMatchObject({ rank_category: 'positive', rank_order: 0, revision: 1 });
    expect(Number(score.volume_usd)).toBe(5);
    expect(await jobRow(tokenA)).toBeUndefined();
  });

  it('makes a published score unavailable immediately when its launch is invalidated again', async () => {
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() - 1_000));
    const [claim] = await claimVolumeJobs(pool, now, 1);
    await publishVolumeScore(pool, claim, scoreFor('5', 'positive'));
    await invalidateLaunchVolume(db, [keyA], now);
    const score = (await pool.query('SELECT volume_usd, rank_category, rank_order, completeness_reason FROM launch_volume24h_usd WHERE token_address = $1', [tokenA])).rows[0];
    expect(score).toMatchObject({ volume_usd: null, rank_category: 'null', rank_order: 2, completeness_reason: 'updating' });
  });

  it('ignores invalidation for a launch that reorg repair already deleted', async () => {
    const missing: LaunchKey = { chainId: 4663, tokenAddress: `0x${'53'.repeat(20)}` };
    await invalidateLaunchVolume(db, [missing, keyA], now);
    expect(await jobRow(missing.tokenAddress)).toBeUndefined();
    expect((await jobRow(tokenA)).revision).toBe(1);
  });

  it('rejects an inconsistent rank category at the database boundary', async () => {
    await invalidateLaunchVolume(db, [keyA], new Date(now.getTime() - 1_000));
    const [claim] = await claimVolumeJobs(pool, now, 1);
    await expect(publishVolumeScore(pool, claim, scoreFor('0', 'positive'))).rejects.toThrow();
  });
});
