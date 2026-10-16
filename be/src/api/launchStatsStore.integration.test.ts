import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readLaunchStats, readLaunchStatsSnapshots, writeLaunchStats } from './launchStatsStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const source = 'launch-stats-test-src';
const tokenWithStats = `0x${'f1'.repeat(20)}`;
const tokenWithout = `0x${'f2'.repeat(20)}`;
const stats = { fdvUsd: '1000', marketCapUsd: '1000', priceUsd: null, week52High: null, week52Low: null, week52HighUsd: null, week52LowUsd: null, change1h: '1.5', change1d: null,
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
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date());
    const found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }, { chainId, tokenAddress: tokenWithout }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)).toEqual(stats);
    expect(found.has(`${chainId}:${tokenWithout}`)).toBe(false);
  });

  it('overwrites an existing row when the launch is recomputed', async () => {
    await writeLaunchStats(pool, chainId, tokenWithStats, { ...stats, fdvUsd: '2000' }, new Date());
    const found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)?.fdvUsd).toBe('2000');
  });

  it('returns the stored computation timestamp with retained stats', async () => {
    const computedAt = new Date(Date.now() - 60_000);
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, computedAt);
    const snapshot = (await readLaunchStatsSnapshots(pool, [{ chainId, tokenAddress: tokenWithStats }])).get(`${chainId}:${tokenWithStats}`);
    expect(snapshot?.stats).toEqual(stats);
    expect(snapshot?.computedAt.getTime()).toBe(computedAt.getTime());
  });

  it('keeps serving the stored figures while a refresh is requested, and clears the request only for a write that started after it', async () => {
    const flag = () => pool.query('SELECT refresh_requested_at FROM launch_stats WHERE chain_id = $1 AND token_address = $2', [chainId, tokenWithStats])
      .then((r) => r.rows[0].refresh_requested_at as Date | null);
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date());
    await pool.query('UPDATE launch_stats SET refresh_requested_at = now() WHERE chain_id = $1 AND token_address = $2', [chainId, tokenWithStats]);
    const found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)?.tvlUsd).toBe('250');
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date(), new Date(Date.now() - 60_000));
    expect(await flag()).not.toBeNull();
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date(), new Date());
    expect(await flag()).toBeNull();
  });

  it('retains stored TVL after a transient RPC price failure but clears it when no verified feed exists', async () => {
    await writeLaunchStats(pool, chainId, tokenWithStats, stats, new Date());
    await writeLaunchStats(pool, chainId, tokenWithStats, { ...stats, tvlUsd: null, tvlBasis: null,
      tvlBlockNumber: null, tvlPriceSource: null, tvlPriceUpdatedAt: null,
      tvlUnavailableReason: 'quote_price_read_failed' }, new Date());
    let found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)?.tvlUsd).toBe('250');
    expect(found.get(`${chainId}:${tokenWithStats}`)?.tvlUnavailableReason).toBe('quote_price_read_failed');

    await writeLaunchStats(pool, chainId, tokenWithStats, { ...stats, tvlUsd: null, tvlBasis: null,
      tvlBlockNumber: null, tvlPriceSource: null, tvlPriceUpdatedAt: null,
      tvlUnavailableReason: 'quote_price_unavailable' }, new Date());
    found = await readLaunchStats(pool, [{ chainId, tokenAddress: tokenWithStats }]);
    expect(found.get(`${chainId}:${tokenWithStats}`)?.tvlUsd).toBeNull();
  });
});
