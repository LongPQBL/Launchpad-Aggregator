import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { readPoolRollingVolume, readPoolStats, readPoolTrades } from './stats.js';
import { insertTvlSnapshot } from './tvlSnapshots.js';
import { markRollupBackfilled } from '../charts/rollupState.js';
import { __resetUsdPriceCacheForTests } from '../market/usdPricing.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const hook = '0xcccccccccccccccccccccccccccccccccccccccc';
const feed = '0xdddddddddddddddddddddddddddddddddddddddd';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const key = { chainId, protocol: 'uniswap_v4' as const, poolId };
const rpcClient = {
  async getBlockNumber() { return 300n; },
  async readContract({ functionName, address }: { functionName: string; address: string }) {
    if (functionName === 'decimals') return address.toLowerCase() === feed ? 8 : 18;
    if (functionName === 'totalSupply') return 1000n * 10n ** 18n;
    if (functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, 4000n, 1n];
    if (functionName === 'getPoolTVL') return {
      coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n, sqrtPriceX96: 2n ** 96n,
      hasCustomAccounting: false,
    };
    throw new Error(`Unexpected ${functionName}`);
  },
};
let hadRollupBeforeSuite = false;

beforeAll(async () => {
  hadRollupBeforeSuite = (await pool.query("SELECT 1 FROM chart_rollup_state WHERE name='pool_volume_done'")).rowCount === 1;
  await markRollupBackfilled(pool, 'pool_volume');
  await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
    block_number,block_hash,tx_hash,log_index,verified,coverage_status)
    VALUES ($1,'uniswap_v4',$2,$3,$4,3000,60,$5,99,$6,$7,0,true,'caught_up')
    ON CONFLICT (chain_id,protocol,pool_id) DO UPDATE SET coverage_status='caught_up'`,
  [chainId, poolId, a, b, hook, tx('1'), tx('2')]);
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id,quote_asset_address,feed_address,discovery_source,verification_status,last_checked_at)
    VALUES ($1,$2,$3,'test','verified',now()) ON CONFLICT (chain_id,quote_asset_address) DO UPDATE SET
      feed_address=EXCLUDED.feed_address,verification_status='verified'`, [chainId, b, feed]);
  for (const [round, block, price, updatedAt] of [[1, 100, 200_000_000, 1000], [2, 200, 400_000_000, 2000]]) {
    await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id,feed_address,round_id,answer_raw,decimals,started_at,updated_at,block_number,log_index)
      VALUES ($1,$2,$3,$4,8,$5,$5,$6,0) ON CONFLICT DO NOTHING`, [chainId, feed, round, price, updatedAt, block]);
  }
  for (const [digit, block, timestamp] of [['3', 101, 1000], ['4', 201, 2000]] as const) {
    await pool.query(`INSERT INTO pool_trades (chain_id,tx_hash,log_index,protocol,pool_id,block_number,block_hash,
      timestamp,amount0_raw,amount1_raw,sqrt_price_x96,trader_address,sender_address,fee)
      VALUES ($1,$2,0,'uniswap_v4',$3,$4,$5,$6,$7,$8,$9,$10,$10,3000) ON CONFLICT DO NOTHING`,
    [chainId, tx(digit), poolId, block, tx('5'), timestamp, '-1000000000000000000', '1000000000000000000',
      (2n ** 96n).toString(), a]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, poolId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id=$1 AND feed_address=$2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  if (!hadRollupBeforeSuite) await pool.query("DELETE FROM chart_rollup_state WHERE name='pool_volume_done'");
  await pool.end();
});

describe('readPoolStats', () => {
  it('measures price change from the first trade for a pool younger than the window', async () => {
    const withoutAge = await readPoolStats(pool, key, a, 4000, { rpcClient });
    expect(withoutAge.change1d).toBeNull();
    const young = await readPoolStats(pool, key, a, 4000, { rpcClient, createdTimestamp: 900 });
    expect(young.change1d).toBe('0');
  });
  it('reports a 0 price change for a fully indexed pool that has never had a swap, not an unknown one', async () => {
    const idleId = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [a, b, 3000, 61, hook],
    ));
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,
      block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES ($1,'uniswap_v4',$2,$3,$4,3000,61,$5,99,$6,$7,1,true,'caught_up')
      ON CONFLICT (chain_id,protocol,pool_id) DO UPDATE SET coverage_status='caught_up'`, [chainId, idleId, a, b, hook, tx('1'), tx('2')]);
    try {
      const idle = await readPoolStats(pool, { chainId, protocol: 'uniswap_v4', poolId: idleId }, a, 4000, { rpcClient, createdTimestamp: 900 });
      expect(idle.change1h).toBe('0');
      expect(idle.change1d).toBe('0');
      await pool.query("UPDATE pool_catalog SET coverage_status='backfilling' WHERE chain_id=$1 AND pool_id=$2", [chainId, idleId]);
      const behind = await readPoolStats(pool, { chainId, protocol: 'uniswap_v4', poolId: idleId }, a, 4000, { rpcClient, createdTimestamp: 900 });
      expect(behind.change1d).toBeNull();
    } finally {
      await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, idleId]);
    }
  });
  it('reports the TVL change against the snapshot taken ~24h earlier through the same quote asset', async () => {
    await insertTvlSnapshot(pool, { chainId, protocol: 'uniswap_v4', poolId, blockNumber: 5n, capturedAtSeconds: 1600,
      coreAmount0Raw: 1n, coreAmount1Raw: 1n, sqrtPriceX96: 1n, quoteAddress: b, tvlUsd: '25' });
    try {
      const stats = await readPoolStats(pool, key, a, 88_000, { rpcClient });
      expect(stats.tvlUsd).toBe('20');
      expect(Number(stats.tvlChange)).toBeCloseTo(-20);
      const noSnapshot = await readPoolStats(pool, key, a, 4000, { rpcClient });
      expect(noSnapshot.tvlChange).toBeNull();
    } finally {
      await pool.query('DELETE FROM pool_tvl_snapshots WHERE pool_id=$1', [poolId]);
    }
  });
  it('compares the current 24h volume with the previous 24h window', async () => {
    const stats = await readPoolStats(pool, key, a, 88_000, { rpcClient });
    expect(stats.volume24hUsd).toBe('4');
    expect(Number(stats.volume24hChange)).toBeCloseTo(100);
  });
  it('reads the price of a pool with no swap in the last 24 h from its current on-chain state', async () => {
    const stats = await readPoolStats(pool, key, a, 90_000, { rpcClient });
    expect(stats.volume24hUsd).toBe('0');
    expect(Number(stats.priceInQuote)).toBeCloseTo(1);
    expect(stats.priceUsd).not.toBeNull();
    expect(stats.fdvUsd).not.toBeNull();
  });
  it('leaves the volume unknown, not $0, for a pool created before the first indexed block', async () => {
    const before = (await pool.query('SELECT head_block, indexed_from_block FROM envio_chain_progress WHERE chain_id = $1', [chainId])).rows[0];
    await pool.query(`INSERT INTO envio_chain_progress (chain_id, head_block, indexed_from_block) VALUES ($1, 1000, 500)
      ON CONFLICT (chain_id) DO UPDATE SET indexed_from_block = 500`, [chainId]);
    try {
      expect((await readPoolStats(pool, key, a, 90_000, { rpcClient })).volume24hUsd).toBeNull(); // created at block 99 < 500
      await pool.query('UPDATE envio_chain_progress SET indexed_from_block = 50 WHERE chain_id = $1', [chainId]);
      expect((await readPoolStats(pool, key, a, 90_000, { rpcClient })).volume24hUsd).toBe('0'); // indexed from before the pool existed
    } finally {
      if (before) await pool.query('UPDATE envio_chain_progress SET head_block = $2, indexed_from_block = $3 WHERE chain_id = $1', [chainId, before.head_block, before.indexed_from_block]);
      else await pool.query('DELETE FROM envio_chain_progress WHERE chain_id = $1', [chainId]);
    }
  });
  it('reads the balances, price and TVL of a V3 pool from its token balances and slot0, and of a V2 pair from its reserves', async () => {
    const v3 = `0x${'3a'.repeat(20)}`;
    const v2 = `0x${'2a'.repeat(20)}`;
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES ($1,'uniswap_v3',$2,$3,$4,3000,60,$7,99,$5,$6,0,true,'caught_up'),($1,'uniswap_v2',$8,$3,$4,3000,0,$7,99,$5,$6,1,true,'caught_up')
      ON CONFLICT (chain_id,protocol,pool_id) DO NOTHING`, [chainId, v3, a, b, tx('c'), tx('d'), '0x0000000000000000000000000000000000000000', v2]);
    const client = {
      async getBlockNumber() { return 300n; },
      async readContract({ functionName, address, args }: { functionName: string; address: string; args?: readonly unknown[] }) {
        if (functionName === 'decimals') return address.toLowerCase() === feed ? 8 : 18;
        if (functionName === 'totalSupply') return 1000n * 10n ** 18n;
        if (functionName === 'latestRoundData') return [1n, 400_000_000n, 0n, 4000n, 1n];
        if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true];
        if (functionName === 'balanceOf') return String(args?.[0]).toLowerCase() === v3 ? 5n * 10n ** 18n : 0n;
        if (functionName === 'getReserves') return [8n * 10n ** 18n, 2n * 10n ** 18n, 0];
        throw new Error(`Unexpected ${functionName}`);
      },
    };
    try {
      const three = await readPoolStats(pool, { chainId, protocol: 'uniswap_v3', poolId: v3 }, a, 90_000, { rpcClient: client });
      expect(three.poolBalances).toMatchObject({ displayedAmountRaw: (5n * 10n ** 18n).toString(), otherAmountRaw: (5n * 10n ** 18n).toString() });
      expect(three.tvlUsd).not.toBeNull();
      const two = await readPoolStats(pool, { chainId, protocol: 'uniswap_v2', poolId: v2 }, a, 90_000, { rpcClient: client });
      expect(two.poolBalances).toMatchObject({ displayedAmountRaw: (8n * 10n ** 18n).toString(), otherAmountRaw: (2n * 10n ** 18n).toString() });
      expect(Number(two.priceInQuote)).toBeCloseTo(0.25); // 2 quote for 8 tokens
    } finally {
      await pool.query('DELETE FROM pool_catalog WHERE chain_id = $1 AND pool_id = ANY($2)', [chainId, [v3, v2]]);
    }
  });
  it('values each trade at its own historical round and derives pool price for either side', async () => {
    const statsA = await readPoolStats(pool, key, a, 4000, { rpcClient });
    expect(statsA.volume24hUsd).toBe('6');
    expect(statsA.volume24hChange).toBeNull();
    expect(statsA.priceInQuote).toBe('1');
    expect(statsA.priceUsd).toBe('4');
    expect(statsA.fdvUsd).toBe('4000');
    expect(statsA.tvlUsd).toBe('20');
    expect(statsA.poolBalances).toEqual({ displayedAmountRaw: '3000000000000000000',
      otherAmountRaw: '2000000000000000000', priceInQuote: '1' });
    const statsB = await readPoolStats(pool, key, b, 4000, { rpcClient });
    expect(statsB.priceInQuote).toBe('1');
    expect(statsB.poolBalances).toEqual({ displayedAmountRaw: '2000000000000000000',
      otherAmountRaw: '3000000000000000000', priceInQuote: '1' });
  });

  it('shows current RPC price and TVL while the historical pool backfill is still running', async () => {
    await pool.query("UPDATE pool_catalog SET coverage_status='backfilling' WHERE chain_id=$1 AND protocol='uniswap_v4' AND pool_id=$2", [chainId, poolId]);
    try {
      const stats = await readPoolStats(pool, key, a, 4000, { rpcClient });
      expect(stats.priceInQuote).toBe('1');
      expect(stats.priceUsd).toBe('4');
      expect(stats.tvlUsd).toBe('20');
      expect(stats.volume24hUsd).toBeNull();
    } finally {
      await pool.query("UPDATE pool_catalog SET coverage_status='caught_up' WHERE chain_id=$1 AND protocol='uniswap_v4' AND pool_id=$2", [chainId, poolId]);
    }
  });

  it('includes a dirty full hour in the rolling volume before the bucket worker runs', async () => {
    const hadRollup = (await pool.query("SELECT 1 FROM chart_rollup_state WHERE name='pool_volume_done'")).rowCount === 1;
    await markRollupBackfilled(pool, 'pool_volume');
    try {
      expect(await readPoolRollingVolume(pool, key, { seconds: 86_400, end: 4000, rpcClient })).toBe('6');
      await pool.query(`INSERT INTO pool_candle_dirty_buckets (chain_id, protocol, pool_id, bucket_start)
        VALUES ($1,'uniswap_v4',$2,960) ON CONFLICT DO NOTHING`, [chainId, poolId]);
      expect(await readPoolRollingVolume(pool, key, { seconds: 86_400, end: 4000, rpcClient })).toBe('6');
    } finally {
      await pool.query("DELETE FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol='uniswap_v4' AND pool_id=$2 AND bucket_start=960", [chainId, poolId]);
      if (!hadRollup) await pool.query("DELETE FROM chart_rollup_state WHERE name='pool_volume_done'");
    }
  });

  it('returns no pool balance snapshot when the Lens reports custom accounting', async () => {
    const customAccountingClient = {
      ...rpcClient,
      async readContract({ functionName, address }: { functionName: string; address: string }) {
        if (functionName === 'getPoolTVL') return {
          coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n, sqrtPriceX96: 2n ** 96n,
          hasCustomAccounting: true,
        };
        return rpcClient.readContract({ functionName, address });
      },
    };
    const stats = await readPoolStats(pool, key, a, 4000, { rpcClient: customAccountingClient, previousTvlUsd: '123.45' });
    expect(stats.poolBalances).toBeNull();
    expect(stats.tvlUsd).toBeNull();
  });

  it('returns no pool balance snapshot when the Lens read fails', async () => {
    const failingLensClient = {
      ...rpcClient,
      async readContract({ functionName, address }: { functionName: string; address: string }) {
        if (functionName === 'getPoolTVL') throw new Error('Lens unavailable');
        return rpcClient.readContract({ functionName, address });
      },
    };
    const stats = await readPoolStats(pool, key, a, 4000, { rpcClient: failingLensClient });
    expect(stats.poolBalances).toBeNull();
    expect(stats.tvlUsd).toBeNull();
    const retained = await readPoolStats(pool, key, a, 4000, { rpcClient: failingLensClient, previousTvlUsd: '123.45' });
    expect(retained.tvlUsd).toBe('123.45');
  });

  it('retains previous TVL when the verified quote price RPC read fails', async () => {
    __resetUsdPriceCacheForTests();
    const failingPriceClient = { ...rpcClient, async readContract({ functionName, address }: { functionName: string; address: string }) {
      if (functionName === 'latestRoundData') throw new Error('RPC unavailable');
      return rpcClient.readContract({ functionName, address });
    } };
    try {
      const stats = await readPoolStats(pool, key, a, 4000, { rpcClient: failingPriceClient, previousTvlUsd: '123.45' });
      expect(stats.tvlUsd).toBe('123.45');
    } finally { __resetUsdPriceCacheForTests(); }
  });

  it('preserves positive Lens spot prices below 1e-18 for the composition bar', async () => {
    const smallPriceClient = {
      ...rpcClient,
      async readContract({ functionName, address }: { functionName: string; address: string }) {
        if (functionName === 'getPoolTVL') return {
          coreAmount0: 3n * 10n ** 18n, coreAmount1: 2n * 10n ** 18n,
          sqrtPriceX96: 2n ** 64n, hasCustomAccounting: false,
        };
        return rpcClient.readContract({ functionName, address });
      },
    };
    const stats = await readPoolStats(pool, key, a, 4000, { rpcClient: smallPriceClient });
    expect(Number(stats.priceInQuote)).toBeGreaterThan(0);
    expect(Number(stats.poolBalances?.priceInQuote)).toBeGreaterThan(0);
  });

  it('labels side using the same sign convention as the official V4 decoder (be/src/launchpads/pons/v2/v4Swaps.ts) — token amount negative means the trader gave the token away, a sell', async () => {
    // Fixture seeds amount0_raw (token a, the displayed/currency0 side) = -1e18 and
    // amount1_raw (quote b) = +1e18 for both rows — the trader's token balance decreased, so
    // this is a sell from the trader's perspective, matching v4Swaps.ts's
    // `quoteSigned < 0n ? 'buy' : 'sell'` (quote positive here, so 'sell').
    const page = await readPoolTrades(pool, key, a, { limit: 2, rpcClient });
    expect(page.items.every((item) => item.side === 'sell')).toBe(true);
  });

  it('pages only this pool and values each transaction at its historical round', async () => {
    const first = await readPoolTrades(pool, key, a, { limit: 1, rpcClient });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ txHash: tx('4'), usdValue: '4', usdValueStatus: 'priced' });
    expect(first.nextCursor).not.toBeNull();
    const second = await readPoolTrades(pool, key, a, { limit: 1, cursor: first.nextCursor!, rpcClient });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ txHash: tx('3'), usdValue: '2', usdValueStatus: 'priced' });
    expect(second.nextCursor).toBeNull();
  });

  it('uses the last trade before the 24h window as the 1d change baseline', async () => {
    const stats = await readPoolStats(pool, key, a, 1000 + 86_400 + 500, { rpcClient });
    expect(stats.change1d).not.toBeNull();
  });

  it('returns null USD volume when one positive trade has no historical price', async () => {
    await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id=$1 AND feed_address=$2', [chainId, feed]);
    const stats = await readPoolStats(pool, key, a, 4000, { rpcClient });
    expect(stats.volume24hUsd).toBeNull();
    for (const [round, block, price, updatedAt] of [[1, 100, 200_000_000, 1000], [2, 200, 400_000_000, 2000]]) {
      await pool.query(`INSERT INTO quote_usd_price_rounds (chain_id,feed_address,round_id,answer_raw,decimals,started_at,updated_at,block_number,log_index)
        VALUES ($1,$2,$3,$4,8,$5,$5,$6,0) ON CONFLICT DO NOTHING`, [chainId, feed, round, price, updatedAt, block]);
    }
  });
});
