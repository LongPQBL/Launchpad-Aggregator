import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { __resetUsdPriceCacheForTests } from '../market/usdPricing.js';
import { captureTvlSnapshots, runSnapshotCycle } from './tvlCapture.js';
import { insertTvlSnapshot } from './tvlSnapshots.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const hook = '0x3333333333333333333333333333333333333333';
const feed = '0x4444444444444444444444444444444444444444';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const now = 4000;

function clientWith(lens: unknown) {
  return {
    async getBlockNumber() { return 300n; },
    async readContract({ functionName, address }: { functionName: string; address: string }) {
      if (functionName === 'decimals') return address.toLowerCase() === feed ? 8 : 18;
      if (functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, 4000n, 1n];
      if (functionName === 'getPoolTVL') { if (lens instanceof Error) throw lens; return lens; }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
}
const goodLens = { coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n, sqrtPriceX96: 2n ** 96n, hasCustomAccounting: false };
const rows = () => pool.query('SELECT quote_address, tvl_usd, block_number FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
const seed = (blockNumber: bigint, capturedAtSeconds: number, tvlUsd: string) => insertTvlSnapshot(pool, {
  chainId, protocol: 'uniswap_v4', poolId, blockNumber, capturedAtSeconds,
  coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd,
});

beforeAll(async () => {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,99,$6,$7,0,true,'caught_up')
    ON CONFLICT (chain_id,protocol,pool_id) DO NOTHING`, [chainId, poolId, a, b, hook, tx('1'), tx('2')]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id,quote_asset_address,feed_address,discovery_source,verification_status,last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id,quote_asset_address) DO UPDATE SET
      feed_address=EXCLUDED.feed_address,verification_status='verified'`, [chainId, b, feed]);
});
beforeEach(() => { __resetUsdPriceCacheForTests(); });
afterEach(async () => { await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]); });
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, poolId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  await pool.end();
});

describe('captureTvlSnapshots', () => {
  it('records raw amounts and the USD TVL priced through the side that has a verified feed', async () => {
    const result = await captureTvlSnapshots(pool, clientWith(goodLens), now);
    expect(result.captured).toBeGreaterThanOrEqual(1);
    const stored = (await rows()).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].quote_address).toBe(b);
    expect(Number(stored[0].tvl_usd)).toBeCloseTo(20); // (2e18 quote + 3e18 token at price 1) x $4
  });
  it('writes nothing when the lens read fails or reports custom accounting', async () => {
    await captureTvlSnapshots(pool, clientWith(new Error('rpc down')), now, () => {});
    await captureTvlSnapshots(pool, clientWith({ ...goodLens, hasCustomAccounting: true }), now);
    await captureTvlSnapshots(pool, clientWith({ ...goodLens, sqrtPriceX96: 0n }), now);
    expect((await rows()).rows).toHaveLength(0);
  });
});

describe('runSnapshotCycle', () => {
  it('still prunes old snapshots when every capture failed', async () => {
    await seed(1n, now - 10 * 3600, '1');
    await seed(2n, now - 3600, '2');
    const result = await runSnapshotCycle(pool, clientWith(new Error('rpc down')), { intervalSeconds: 3600, retentionHours: 26 }, now + 40 * 3600);
    expect(result.pruned).toBeGreaterThanOrEqual(2);
    expect((await rows()).rows).toHaveLength(0);
  });
  it('keeps snapshots inside the retention window', async () => {
    await seed(1n, now - 20 * 3600, '1');
    await runSnapshotCycle(pool, clientWith(goodLens), { intervalSeconds: 3600, retentionHours: 26 }, now);
    expect((await rows()).rows).toHaveLength(2);
  });
});
