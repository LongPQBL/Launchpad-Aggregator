import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readLaunchStats, writeLaunchStats } from './launchStatsStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const source = 'launch-stats-test-src';
const tokenWithStats = `0x${'f1'.repeat(20)}`;
const tokenWithout = `0x${'f2'.repeat(20)}`;
const stats = { fdvUsd: '1000', marketCapUsd: '1000', week52High: null, week52Low: null, change1h: '1.5', change1d: null,
  tvlUsd: '250', tvlBasis: 'pool_principal' as const, tvlBlockNumber: '10', tvlPriceSource: 'chainlink' as const, tvlPriceUpdatedAt: null, tvlUnavailableReason: null };

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v1', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'f3'.repeat(20)}`]);
  for (const token of [tokenWithStats, tokenWithout]) {
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
      protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
      quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES ($1, $2, $3, 'Stats', 'STS', 18, 'pons', 'v1', $2, $2, 100, $4, 0, $5, 'WETH', 18, 'trading') ON CONFLICT DO NOTHING`,
    [chainId, token, source, `0x${'f4'.repeat(32)}`, `0x${'f5'.repeat(20)}`]);
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM launch_stats WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, [tokenWithStats, tokenWithout]]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = ANY($2)', [chainId, [tokenWithStats, tokenWithout]]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('launch stats store', () => {
  it('writes a computed stats row and reads it back by launch, leaving launches without a row absent', async () => {
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date('2026-10-05T12:00:00Z'));
    const found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }, { chainId, tokenAddress: tokenWithout }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)).toEqual(stats);
    expect(found.has(`${chainId}:${tokenWithout}`)).toBe(false);
  });

  it('overwrites an existing row when the launch is recomputed', async () => {
    await writeLaunchStats(pool, chainId, tokenWithStats, { ...stats, fdvUsd: '2000' }, new Date());
    const found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)?.fdvUsd).toBe('2000');
  });
});
