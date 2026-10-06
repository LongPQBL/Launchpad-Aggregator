import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { encodeAbiParameters, keccak256 } from 'viem';
import { readPoolStats, readPoolTrades } from './stats.js';

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
      coreAmount0: 10n ** 18n, coreAmount1: 10n ** 18n, sqrtPriceX96: 2n ** 96n,
      hasCustomAccounting: false,
    };
    throw new Error(`Unexpected ${functionName}`);
  },
};

beforeAll(async () => {
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
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id=$2', [chainId, poolId]);
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id=$1 AND feed_address=$2', [chainId, feed]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id=$1 AND quote_asset_address=$2', [chainId, b]);
  await pool.end();
});

describe('readPoolStats', () => {
  it('values each trade at its own historical round and derives pool price for either side', async () => {
    const statsA = await readPoolStats(pool, key, a, 4000, { rpcClient });
    expect(statsA.volume24hUsd).toBe('6');
    expect(statsA.priceInQuote).toBe('1');
    expect(statsA.priceUsd).toBe('4');
    expect(statsA.fdvUsd).toBe('4000');
    expect(statsA.tvlUsd).toBe('8');
    const statsB = await readPoolStats(pool, key, b, 4000, { rpcClient });
    expect(statsB.priceInQuote).toBe('1');
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
