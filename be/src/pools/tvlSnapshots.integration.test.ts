import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { insertTvlSnapshot, pruneTvlSnapshots, readTvlChange } from './tvlSnapshots.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const poolId = `0x${'7'.repeat(64)}`;
const key = { chainId: 4663, protocol: 'uniswap_v4' as const, poolId };
const quote = '0x0000000000000000000000000000000000000000';
const asOf = 1_800_000_000;
const mark = asOf - 86_400;

async function snap(secondsFromMark: number, tvlUsd: string, quoteAddress = quote, block = 1000 + secondsFromMark) {
  await insertTvlSnapshot(pool, {
    chainId: 4663, protocol: 'uniswap_v4', poolId, blockNumber: BigInt(block), capturedAtSeconds: mark + secondsFromMark,
    coreAmount0Raw: 1n, coreAmount1Raw: 2n, sqrtPriceX96: 3n, quoteAddress, tvlUsd,
  });
}
afterEach(async () => { await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]); });
afterAll(async () => { await pool.end(); });

describe('readTvlChange', () => {
  it('uses the snapshot nearest to 24h ago and returns the percent change', async () => {
    await snap(-5000, '100');
    await snap(600, '200');
    expect(Number(await readTvlChange(pool, key, quote, '150', asOf))).toBeCloseTo(-25);
  });
  it('is null when no snapshot is within 2h of the 24h mark (e.g. the first 24h)', async () => {
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
    await snap(-8000, '100');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
  });
  it('is null when the snapshot was priced through a different quote asset', async () => {
    await snap(0, '100', '0x1111111111111111111111111111111111111111');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
  });
  it('is null when the previous TVL is zero or the current TVL is unavailable', async () => {
    await snap(0, '0');
    expect(await readTvlChange(pool, key, quote, '150', asOf)).toBeNull();
    await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
    await snap(0, '100');
    expect(await readTvlChange(pool, key, quote, null, asOf)).toBeNull();
  });
});

describe('pruneTvlSnapshots', () => {
  it('deletes only rows older than the cutoff and reports how many', async () => {
    await snap(-200_000, '1');
    await snap(-100_000, '2');
    await snap(0, '3');
    const deleted = await pruneTvlSnapshots(pool, mark - 150_000);
    expect(deleted).toBe(1);
    const left = await pool.query('SELECT tvl_usd FROM pool_tvl_snapshots WHERE pool_id=$1 ORDER BY captured_at', [poolId]);
    expect(left.rows.map((row) => Number(row.tvl_usd))).toEqual([2, 3]);
  });
});
