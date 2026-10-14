import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ApiEventBus, type ApiEvent } from './events.js';
import { startLiveLaunchStats } from './liveLaunchStats.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const fakePool = {} as Pool;
const fakeClient = {} as never;

describe('startLiveLaunchStats', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(recompute = vi.fn(async () => true), options = {}) {
    const bus = new ApiEventBus();
    const announced: ApiEvent[] = [];
    bus.subscribe((event) => { if (event.type === 'launch.changed') announced.push(event); });
    const stop = startLiveLaunchStats(fakePool, fakeClient, bus, { recompute, ...options });
    return { bus, announced, recompute, stop };
  }

  it('recomputes a launch when a trade is announced, then announces launch.changed', async () => {
    const { bus, announced, recompute, stop } = setup();
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(recompute).toHaveBeenCalledWith(fakePool, fakeClient, 4663, TOKEN);
    expect(announced).toEqual([expect.objectContaining({ type: 'launch.changed', chainId: 4663, tokenAddress: TOKEN })]);
    stop();
  });

  it('ignores events that are not trades, and does not react to its own launch.changed', async () => {
    const { bus, recompute, stop } = setup();
    bus.publish({ type: 'launch.changed', chainId: 4663, tokenAddress: TOKEN });
    bus.publish({ type: 'coverage.changed', chainId: 4663 });
    bus.publish({ type: 'pool.changed', chainId: 4663, poolId: `0x${'ab'.repeat(32)}` });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recompute).not.toHaveBeenCalled();
    stop();
  });

  it('recomputes a busy launch at most once per interval, folding the trades in between into one run', async () => {
    const { bus, recompute, stop } = setup(undefined, { minIntervalMs: 2_000 });
    for (let i = 0; i < 5; i += 1) bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(recompute).toHaveBeenCalledTimes(1);
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recompute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(recompute).toHaveBeenCalledTimes(2);
    stop();
  });

  it('limits how many launches are recomputed at once and drops the overflow of a full queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recompute = vi.fn(async () => { await gate; return true; });
    const { bus, stop } = setup(recompute, { concurrency: 1, maxQueue: 1 });
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: OTHER });
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: '0x3333333333333333333333333333333333333333' });
    await vi.advanceTimersByTimeAsync(0);
    expect(recompute).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(recompute).toHaveBeenCalledTimes(2); // OTHER ran; the third launch did not fit the queue
    stop();
  });

  it('keeps going after a failed recomputation and announces nothing for it', async () => {
    const recompute = vi.fn().mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(true);
    const { bus, announced, stop } = setup(recompute, { minIntervalMs: 10 });
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(announced).toHaveLength(0);
    bus.publish({ type: 'trade.created', chainId: 4663, tokenAddress: TOKEN });
    await vi.advanceTimersByTimeAsync(50);
    expect(announced).toHaveLength(1);
    stop();
  });
});
