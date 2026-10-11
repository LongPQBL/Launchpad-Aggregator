import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { markRollupBackfilled } from '../charts/rollupState.js';
import { insertTvlSnapshot } from '../pools/tvlSnapshots.js';
import { readLaunchHistory } from './launchHistory.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'all-pools-test-src';
const token = `0x${'a1'.repeat(20)}`;
const quote = `0x${'b2'.repeat(20)}`;
const unpricedQuote = `0x${'b3'.repeat(20)}`;
const feed = `0x${'b4'.repeat(20)}`;
const officialPool = `0x${'c1'.repeat(32)}`; // a V4 pool id
const v3Pool = `0x${'c2'.repeat(20)}`;
const unpricedPool = `0x${'c3'.repeat(20)}`;
const latePool = `0x${'c4'.repeat(20)}`;
const base = 1_800_000_000; // a multiple of 3600
const HOUR = 3600;
const rpcClient = { async readContract({ functionName }: { functionName: string }) { if (functionName === 'decimals') return 18; throw new Error(functionName); } };
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const options = { chainId, tokenAddress: token, intervalSeconds: HOUR, buckets: 3, asOf: base + 2 * HOUR + 10, complete: true, rpcClient };

async function catalog(protocol: string, poolId: string, currency0: string, currency1: string, coverage = 'caught_up') {
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,$2,$3,$4,$5,3000,60,$6,99,$7,$8,0,true,$9) ON CONFLICT DO NOTHING`,
  [chainId, protocol, poolId, currency0, currency1, `0x${'00'.repeat(20)}`, tx(1), tx(2), coverage]);
  await pool.query('INSERT INTO pool_members (chain_id,protocol,pool_id,token_address) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [chainId, protocol, poolId, token]);
}
async function poolVolume(protocol: string, poolId: string, bucket: number, usd: bigint, unpriced = 0) {
  await pool.query(`INSERT INTO pool_volume_buckets (chain_id,protocol,pool_id,interval_seconds,bucket_start,trade_count,usd_scaled0,unpriced0,usd_scaled1,unpriced1)
    VALUES ($1,$2,$3,$4,$5,1,0,0,$6,$7) ON CONFLICT DO NOTHING`, [chainId, protocol, poolId, HOUR, bucket, (usd * 10n ** 18n).toString(), unpriced]);
}
async function poolTrade(protocol: string, poolId: string, timestamp: number) {
  await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,timestamp,amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
    VALUES ($1,$2,0,$3,$4,100,$5,$6,'1','1',$7,$8,$8,3000) ON CONFLICT DO NOTHING`,
  [chainId, tx(timestamp), protocol, poolId, tx(3), timestamp, (2n ** 96n).toString(), token]);
}
const snapshot = (protocol: 'uniswap_v4' | 'uniswap_v3', poolId: string, at: number, tvlUsd: string) => insertTvlSnapshot(pool, {
  chainId, protocol, poolId, blockNumber: BigInt(at), capturedAtSeconds: at, coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: quote, tvlUsd });

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,$2,'v2',$3,0,0,0,'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'a2'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform, protocol_version, factory_address, deployer_address,
    launch_block, launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1,$2,$3,'All pools','ALP',18,'pons','v2',$2,$2,100,$4,0,$5,'ETH',18,'graduated') ON CONFLICT DO NOTHING`, [chainId, token, source, tx(9), quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official) VALUES
    ('all-pools-curve',$1,$2,'curve',$2,$3,1,true), ('all-pools-v4',$1,$2,'v4_pool',$4,$3,1,true) ON CONFLICT DO NOTHING`, [chainId, token, source, officialPool]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, verification_status = 'verified'`, [chainId, quote, feed]);
  await catalog('uniswap_v4', officialPool, token, quote);
  await catalog('uniswap_v3', v3Pool, token, quote);
  // Official trades only live in launch_volume_buckets: $5 on the curve and $7 on the official V4 pool in the second hour.
  await pool.query(`INSERT INTO launch_volume_buckets (chain_id, token_address, venue_kind, interval_seconds, bucket_start, volume_usd, trade_count, unpriced_count) VALUES
    ($1,$2,'curve',$3,$4,5,1,0), ($1,$2,'v4_pool',$3,$4,7,1,0)`, [chainId, token, HOUR, base + HOUR]);
  // The official pool's own pool-level row must NOT be added again; the V3 pool adds $10 in hour 2 and has an unpriced swap in hour 3.
  await poolVolume('uniswap_v4', officialPool, base + HOUR, 7n);
  await poolVolume('uniswap_v3', v3Pool, base + HOUR, 10n);
  await poolVolume('uniswap_v3', v3Pool, base + 2 * HOUR, 3n, 1);
  await markRollupBackfilled(pool, 'launch_volume');
  await markRollupBackfilled(pool, 'pool_volume');
  await snapshot('uniswap_v4', officialPool, base + HOUR + 100, '100');
  await snapshot('uniswap_v3', v3Pool, base + HOUR + 100, '50');
  await snapshot('uniswap_v4', officialPool, base + 2 * HOUR + 100, '110');
});

afterAll(async () => {
  for (const id of [officialPool, v3Pool, unpricedPool, latePool]) {
    for (const table of ['pool_tvl_snapshots', 'pool_tvl_buckets', 'pool_volume_buckets', 'pool_trades', 'pool_members', 'pool_catalog']) {
      await pool.query(`DELETE FROM ${table} WHERE chain_id = $1 AND pool_id = $2`, [chainId, id]);
    }
  }
  await pool.query('DELETE FROM launch_volume_buckets WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query("DELETE FROM chart_rollup_state WHERE name IN ('launch_volume_done','pool_volume_done')");
  await pool.query("DELETE FROM venues WHERE id IN ('all-pools-curve','all-pools-v4')");
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = $2', [chainId, quote]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('readLaunchHistory over all pools', () => {
  it('adds the other pools to the official volume without counting the official pool twice, and nulls a bucket with an unpriced swap', async () => {
    const result = await readLaunchHistory(pool, options);
    expect(result.items.map((item) => item.volumeUsd)).toEqual(['0', '22', null]);
    expect(result.poolCount).toBe(2);
    expect(result.unvaluedPools).toBe(0);
  });

  it('keeps the curve-scoped answer to the curve alone', async () => {
    const result = await readLaunchHistory(pool, { ...options, venueKind: 'curve' });
    expect(result.items.map((item) => item.volumeUsd)).toEqual(['0', '5', '0']);
    expect(result.items.every((item) => item.tvlUsd === null)).toBe(true);
  });

  it('sums each pool\'s TVL per bucket and gives null where an existing pool has no snapshot or nothing exists yet', async () => {
    const result = await readLaunchHistory(pool, options);
    // hour 1: neither pool had a snapshot yet; hour 2: 100 + 50; hour 3: the V3 pool existed but has no snapshot.
    expect(result.items.map((item) => item.tvlUsd)).toEqual([null, '150', null]);
  });

  it('does not let a pool that only appears later null an earlier bucket', async () => {
    await catalog('uniswap_v3', latePool, token, quote);
    await poolTrade('uniswap_v3', latePool, base + 2 * HOUR + 500);
    const result = await readLaunchHistory(pool, options);
    expect(result.items[1]!.tvlUsd).toBe('150');
  });

  it('reports a pool with no USD feed as unvalued and the answer as incomplete, without guessing its volume', async () => {
    await catalog('uniswap_v2', unpricedPool, token, unpricedQuote);
    await poolVolume('uniswap_v2', unpricedPool, base + HOUR, 99n);
    const result = await readLaunchHistory(pool, options);
    expect(result.unvaluedPools).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.items[1]!.volumeUsd).toBe('22');
  });
});
