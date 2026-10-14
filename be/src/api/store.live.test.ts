import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ApiEventBus } from './events.js';

const readCurveDepthAnswer = vi.fn(async () => ({ complete: true }));
vi.mock('../pools/curveDepth.js', () => ({ readCurveDepthAnswer: (...args: unknown[]) => readCurveDepthAnswer(...(args as [])) }));

const { createApiStore } = await import('./store.js');

const rpcClient = { getBlockNumber: async () => 1n, readContract: async () => 18 } as never;
const TOKEN = '0x1111111111111111111111111111111111111111';

describe('launch store curve depth cache', () => {
  beforeEach(() => { vi.useFakeTimers(); readCurveDepthAnswer.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rereads the curve depth after a trade of that launch is announced (at most once a second), and not for another launch', async () => {
    const events = new ApiEventBus();
    const store = createApiStore({} as Pool, rpcClient, events);
    await store.getCurveDepth!(4663, TOKEN);
    await store.getCurveDepth!(4663, TOKEN.toUpperCase().replace('0X', '0x'));
    expect(readCurveDepthAnswer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_100);
    events.publish({ type: 'trade.created', chainId: 4663, tokenAddress: '0x2222222222222222222222222222222222222222' });
    await store.getCurveDepth!(4663, TOKEN);
    expect(readCurveDepthAnswer).toHaveBeenCalledTimes(1);
    events.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await store.getCurveDepth!(4663, TOKEN);
    expect(readCurveDepthAnswer).toHaveBeenCalledTimes(2);
  });
});
