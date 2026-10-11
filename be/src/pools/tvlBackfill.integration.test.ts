import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { __resetUsdPriceCacheForTests } from '../market/usdPricing.js';
import { backfillPoolTvl } from './tvlBackfill.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0x6161616161616161616161616161616161616161';
const b = '0x6262626262626262626262626262626262626262';
const feed = '0x6363636363636363636363636363636363636363';
const pair = '0x6464646464646464646464646464646464646464';
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const now = 1_800_000_000 + 500;
const HEAD = 1_000_000n;
// Block n has timestamp now - 2 * (HEAD - n): a 2-second chain.
const tsOf = (block: bigint) => now - 2 * Number(HEAD - block);

const client = {
  async getBlockNumber() { return HEAD; },
  async getBlock({ blockNumber }: { blockNumber: bigint }) { return { timestamp: BigInt(tsOf(blockNumber)) }; },
  async readContract({ functionName, address, blockNumber }: { functionName: string; address: string; blockNumber?: bigint }) {
    if (functionName === 'decimals') return address.toLowerCase() === feed ? 8 : 18;
    if (functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, BigInt(tsOf(blockNumber ?? HEAD)), 1n];
    if (functionName === 'getReserves') return [3n * 10n ** 18n, 2n * 10n ** 18n, 1];
    throw new Error(`Unexpected ${functionName}`);
  },
};

const buckets = (interval: number) => pool.query('SELECT bucket_start, tvl_usd FROM pool_tvl_buckets WHERE pool_id=$1 AND interval_seconds=$2 ORDER BY bucket_start', [pair, interval]);

beforeAll(async () => {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v2',$2,$3,$4,3000,0,'0x0000000000000000000000000000000000000000',99,$5,$6,0,true,'caught_up') ON CONFLICT DO NOTHING`, [chainId, pair, a, b, tx('1'), tx('2')]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id,quote_asset_address,feed_address,discovery_source,verification_status,last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id,quote_asset_address) DO UPDATE SET feed_address=EXCLUDED.feed_address, verification_status='verified'`, [chainId, b, feed]);
});
beforeEach(async () => { __resetUsdPriceCacheForTests(); await pool.query('DELETE FROM pool_tvl_buckets WHERE pool_id=$1', [pair]); });
afterAll(async () => {
  await pool.query('DELETE FROM pool_tvl_buckets WHERE pool_id=$1', [pair]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, pair]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  await pool.end();
});

describe('backfillPoolTvl', () => {
  it('fills hourly, 4-hour and daily buckets from archive state, valued with the feed answer at that block', async () => {
    const result = await backfillPoolTvl(pool, client, { days: 2, nowSeconds: now, poolConcurrency: 1 });
    expect(result.inserted).toBeGreaterThan(0);
    const daily = (await buckets(86_400)).rows;
    expect(daily.length).toBeGreaterThanOrEqual(1);
    // reserves 3e18 token / 2e18 quote at price 2/3 -> 2e18 + 2e18 = 4e18 quote, x $4 = 16
    expect(Number(daily[0].tvl_usd)).toBeCloseTo(16, 1);
    expect((await buckets(3600)).rows.length).toBeGreaterThanOrEqual(47);
  });

  it('never overwrites an existing bucket and only fills what is missing on a second run', async () => {
    const first = await backfillPoolTvl(pool, client, { days: 1, nowSeconds: now, poolConcurrency: 1 });
    const keep = (await buckets(3600)).rows[0];
    await pool.query('UPDATE pool_tvl_buckets SET tvl_usd = 7 WHERE pool_id=$1 AND interval_seconds=3600 AND bucket_start=$2', [pair, keep.bucket_start]);
    const second = await backfillPoolTvl(pool, client, { days: 1, nowSeconds: now, poolConcurrency: 1 });
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBeGreaterThanOrEqual(first.inserted);
    expect(Number((await buckets(3600)).rows[0].tvl_usd)).toBe(7);
  });

  it('does not read a pool before the block it was created in', async () => {
    await pool.query("UPDATE pool_catalog SET block_number = $2 WHERE chain_id=$1 AND pool_id=$3", [chainId, (HEAD - 100n).toString(), pair]);
    try {
      await backfillPoolTvl(pool, client, { days: 2, nowSeconds: now, poolConcurrency: 1 });
      expect((await buckets(86_400)).rows).toHaveLength(0);
    } finally {
      await pool.query("UPDATE pool_catalog SET block_number = 99 WHERE chain_id=$1 AND pool_id=$2", [chainId, pair]);
    }
  });

  it('leaves a point empty when the feed answer was too old at that time instead of guessing', async () => {
    const stale = { ...client, async readContract(args: Parameters<typeof client.readContract>[0]) {
      if (args.functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, BigInt(tsOf(args.blockNumber ?? HEAD) - 3 * 86_400), 1n];
      return client.readContract(args);
    } };
    const result = await backfillPoolTvl(pool, stale, { days: 2, nowSeconds: now, poolConcurrency: 1 });
    expect(result.inserted).toBe(0);
    expect(result.unreadable).toBeGreaterThan(0);
  });
});
