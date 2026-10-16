import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ApiEventBus } from './events.js';

const readPoolLiquidityAnswer = vi.fn(async () => ({ complete: true }));
vi.mock('../pools/liquidity.js', () => ({ readPoolLiquidityAnswer: (...args: unknown[]) => readPoolLiquidityAnswer(...(args as [])) }));
const readPoolStats = vi.fn(async () => ({ poolBalances: null, volume24hUsd: null, volume24hChange: null, priceInQuote: null,
  priceUsd: null, fdvUsd: null, tvlUsd: null, tvlChange: null, change1h: null, change1d: null, coverageStatus: 'caught_up', lastTradeTimestamp: null }));
const readPoolRollingVolume = vi.fn(async () => null);
const assetDecimals = vi.fn(async () => 18);
vi.mock('../pools/stats.js', () => ({ readPoolStats: (...args: unknown[]) => readPoolStats(...(args as [])),
  readPoolRollingVolume: (...args: unknown[]) => readPoolRollingVolume(...(args as [])),
  assetDecimals: (...args: unknown[]) => assetDecimals(...(args as [])) }));
vi.mock('../pools/tokenMetadata.js', () => ({ createTokenMetadataResolver: () => ({ resolve: async () => ({ symbol: 'TKN', name: 'Token', logoUri: null }) }) }));

const { createPoolApiStore } = await import('./poolStore.js');

const rpcClient = { getBlockNumber: async () => 1n, readContract: async () => 18, call: async () => ({}) } as never;
const V4_ID = `0x${'ab'.repeat(32)}`;
const key = { chainId: 4663, protocol: 'uniswap_v4', poolId: V4_ID.toUpperCase().replace('0X', '0x') } as never;

describe('pool store liquidity cache', () => {
  beforeEach(() => { vi.useFakeTimers(); readPoolLiquidityAnswer.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rereads a pool\'s liquidity after a swap in that pool is announced (at most once a second), and only for that pool', async () => {
    const events = new ApiEventBus();
    const store = createPoolApiStore({} as Pool, rpcClient, undefined, events);
    await store.getPoolLiquidity!(key);
    await store.getPoolLiquidity!(key);
    expect(readPoolLiquidityAnswer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_100);
    events.publish({ type: 'pool.changed', chainId: 4663, poolId: `0x${'cd'.repeat(32)}` });
    await store.getPoolLiquidity!(key);
    expect(readPoolLiquidityAnswer).toHaveBeenCalledTimes(1);
    events.publish({ type: 'pool.changed', chainId: 4663, poolId: V4_ID });
    await store.getPoolLiquidity!(key);
    expect(readPoolLiquidityAnswer).toHaveBeenCalledTimes(2);
    events.publish({ type: 'pool.changed', chainId: 4663, poolId: V4_ID }); // just recomputed: kept
    await store.getPoolLiquidity!(key);
    expect(readPoolLiquidityAnswer).toHaveBeenCalledTimes(2);
  });
});

describe('pool creation time reads', () => {
  it('retries a failed block timestamp read instead of caching null for the process lifetime', async () => {
    let blockReads = 0;
    const rpc = { chain: { id: 4663 }, getBlockNumber: async () => 1n, readContract: async () => 18, call: async () => ({}), getBlock: async () => {
      blockReads += 1;
      if (blockReads === 1) throw new Error('temporary RPC failure');
      return { timestamp: 1_792_000_000n };
    } } as never;
    const row = { chain_id: 4663, protocol: 'uniswap_v4', pool_id: V4_ID, currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x3333333333333333333333333333333333333333', fee: 3000, tick_spacing: 60,
      hooks: '0x0000000000000000000000000000000000000000', block_number: '100', log_index: 0, pons_designated: false,
      launch_token_address: null };
    const db = { query: async (sql: string) => sql.includes('SELECT DISTINCT a.protocol')
      ? { rows: [{ protocol: 'uniswap_v4' }] } : { rows: [row] } } as never;
    const store = createPoolApiStore(db, rpc);
    expect((await store.listPools({ limit: 10 })).items[0]?.createdTimestamp).toBeNull();
    expect((await store.listPools({ limit: 10 })).items[0]?.createdTimestamp).toBe(1_792_000_000);
    expect(blockReads).toBe(2);
  });

  it('limits concurrent pool-stat RPC reads on a large pools page', async () => {
    let active = 0;
    let maximum = 0;
    readPoolStats.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { poolBalances: null, volume24hUsd: null, volume24hChange: null, priceInQuote: null,
        priceUsd: null, fdvUsd: null, tvlUsd: null, tvlChange: null, change1h: null, change1d: null,
        coverageStatus: 'caught_up', lastTradeTimestamp: null };
    });
    const rows = Array.from({ length: 24 }, (_, index) => ({ chain_id: 4663, protocol: 'uniswap_v4',
      pool_id: `0x${index.toString(16).padStart(64, '0')}`, currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x3333333333333333333333333333333333333333', fee: 3000, tick_spacing: 60,
      hooks: '0x0000000000000000000000000000000000000000', block_number: '100', log_index: index,
      pons_designated: false, launch_token_address: null }));
    const db = { query: async (sql: string) => sql.includes('SELECT DISTINCT a.protocol')
      ? { rows: [{ protocol: 'uniswap_v4' }] } : { rows } } as never;
    await createPoolApiStore(db, rpcClient).listPools({ limit: 30 });
    expect(readPoolStats).toHaveBeenCalledTimes(24);
    expect(maximum).toBeLessThanOrEqual(10);
  });
});
