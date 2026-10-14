import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ApiEventBus } from './events.js';

const readPoolLiquidityAnswer = vi.fn(async () => ({ complete: true }));
vi.mock('../pools/liquidity.js', () => ({ readPoolLiquidityAnswer: (...args: unknown[]) => readPoolLiquidityAnswer(...(args as [])) }));

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
