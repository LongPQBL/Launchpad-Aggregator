import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { readPoolDailyHistory, readPoolHistory } from './history.js';
import { insertTvlSnapshot } from './tvlSnapshots.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const b = '0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b';
const hook = '0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c';
const feed = '0x7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const key = { chainId, protocol: 'uniswap_v4' as const, poolId };
const DAY = 86_400;
const rpcClient = {
  async readContract({ functionName }: { functionName: string }) {
    if (functionName === 'decimals') return 18;
    throw new Error(`Unexpected ${functionName}`);
  },
};

async function swap(digit: string, block: number, timestamp: number, quoteRaw: string) {
  await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,
    timestamp,amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
    VALUES ($1,$2,0,'uniswap_v4',$3,$4,$5,$6,'1',$7,$8,$9,$9,3000) ON CONFLICT DO NOTHING`,
  [chainId, tx(digit), poolId, block, tx('5'), timestamp, quoteRaw, (2n ** 96n).toString(), a]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,99,$6,$7,0,true,'caught_up')
    ON CONFLICT (chain_id,protocol,pool_id) DO UPDATE SET coverage_status='caught_up'`, [chainId, poolId, a, b, hook, tx('1'), tx('2')]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id,quote_asset_address,feed_address,discovery_source,verification_status,last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id,quote_asset_address) DO UPDATE SET
      feed_address=EXCLUDED.feed_address,verification_status='verified'`, [chainId, b, feed]);
  // $2.00 from block 100, $4.00 from block 200 (8 decimals).
  for (const [round, block, price, updatedAt] of [[1, 100, 200_000_000, 10 * DAY], [2, 200, 400_000_000, 11 * DAY]]) {
    await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id,feed_address,round_id,answer_raw,decimals,started_at,updated_at,block_number,log_index)
      VALUES ($1,$2,$3,$4,8,$5,$5,$6,0) ON CONFLICT DO NOTHING`, [chainId, feed, round, price, updatedAt, block]);
  }
  // Day 10: one swap of 1 quote token at $2 and one of 2 at $2 = $6. Day 11: one swap of 1 at $4. Day 12: no swaps.
  await swap('3', 101, 10 * DAY + 100, (10n ** 18n).toString());
  await swap('4', 102, 10 * DAY + 200, (2n * 10n ** 18n).toString());
  await swap('6', 201, 11 * DAY + 100, (10n ** 18n).toString());
  await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 150n, capturedAtSeconds: 10 * DAY + 50,
    coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '100' });
  await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 160n, capturedAtSeconds: 10 * DAY + 5000,
    coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '120.5' });
});

afterAll(async () => {
  await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, poolId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id=$1 AND feed_address=$2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  await pool.end();
});

describe('readPoolDailyHistory', () => {
  it('sums each day at the oracle round in force for each swap, with the last TVL snapshot of the day', async () => {
    const history = await readPoolDailyHistory(pool, key, { days: 3, asOf: 12 * DAY + 3600, rpcClient });
    expect(history.complete).toBe(true);
    expect(history.items).toEqual([
      { day: 10 * DAY, tradeCount: 2, volumeUsd: '6', tvlUsd: '120.5' },
      { day: 11 * DAY, tradeCount: 1, volumeUsd: '4', tvlUsd: null },
      { day: 12 * DAY, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
    ]);
  });

  it('reports a day as unavailable, not zero, when one of its swaps predates any oracle round', async () => {
    await swap('7', 50, 9 * DAY + 100, (10n ** 18n).toString());
    const history = await readPoolDailyHistory(pool, key, { days: 4, asOf: 12 * DAY + 3600, rpcClient });
    expect(history.items[0]).toMatchObject({ day: 9 * DAY, tradeCount: 1, volumeUsd: null });
    expect(history.items[1]).toMatchObject({ day: 10 * DAY, volumeUsd: '6' });
  });

  it('leaves volume unavailable when the pool is not fully indexed', async () => {
    await pool.query("UPDATE pool_catalog SET coverage_status='backfilling' WHERE chain_id=$1 AND pool_id=$2", [chainId, poolId]);
    try {
      const history = await readPoolDailyHistory(pool, key, { days: 2, asOf: 11 * DAY + 3600, rpcClient });
      expect(history.complete).toBe(false);
      expect(history.items.every((item) => item.volumeUsd === null)).toBe(true);
    } finally {
      await pool.query("UPDATE pool_catalog SET coverage_status='caught_up' WHERE chain_id=$1 AND pool_id=$2", [chainId, poolId]);
    }
  });

  it('rejects an out-of-range window', async () => {
    await expect(readPoolDailyHistory(pool, key, { days: 0, asOf: 1, rpcClient })).rejects.toThrow('Invalid pool history window');
    await expect(readPoolDailyHistory(pool, key, { days: 91, asOf: 1, rpcClient })).rejects.toThrow('Invalid pool history window');
  });

  it('buckets the same series by an hour: volume per hour and the last TVL snapshot taken inside each hour', async () => {
    const history = await readPoolHistory(pool, key, { intervalSeconds: 3600, buckets: 4, asOf: 10 * DAY + 3 * 3600 + 10, rpcClient });
    expect(history.items).toEqual([
      { day: 10 * DAY, tradeCount: 2, volumeUsd: '6', tvlUsd: '100' },
      { day: 10 * DAY + 3600, tradeCount: 0, volumeUsd: '0', tvlUsd: '120.5' },
      { day: 10 * DAY + 7200, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
      { day: 10 * DAY + 10_800, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
    ]);
  });

  it('rejects an unsupported interval or bucket count', async () => {
    await expect(readPoolHistory(pool, key, { intervalSeconds: 7, buckets: 4, asOf: 1, rpcClient })).rejects.toThrow('Invalid pool history window');
    await expect(readPoolHistory(pool, key, { intervalSeconds: 60, buckets: 201, asOf: 1, rpcClient })).rejects.toThrow('Invalid pool history window');
  });
});
