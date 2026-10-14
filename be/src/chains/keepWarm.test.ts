import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRpcKeepWarm } from './keepWarm.js';

describe('startRpcKeepWarm', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks for the block number without the cache every 1.5 s by default, and stops', () => {
    const getBlockNumber = vi.fn().mockResolvedValue(1n);
    const stop = startRpcKeepWarm({ getBlockNumber }, {});
    vi.advanceTimersByTime(4_600);
    expect(getBlockNumber).toHaveBeenCalledTimes(3);
    expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(getBlockNumber).toHaveBeenCalledTimes(3);
  });

  it('is off with RPC_KEEP_WARM_MS=0 and takes another interval from it', () => {
    const off = vi.fn().mockResolvedValue(1n);
    startRpcKeepWarm({ getBlockNumber: off }, { RPC_KEEP_WARM_MS: '0' });
    vi.advanceTimersByTime(10_000);
    expect(off).not.toHaveBeenCalled();
    const fast = vi.fn().mockResolvedValue(1n);
    startRpcKeepWarm({ getBlockNumber: fast }, { RPC_KEEP_WARM_MS: '500' })();
    expect(fast).not.toHaveBeenCalled();
  });

  it('swallows a failed warm-up call', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('rpc down'));
    const stop = startRpcKeepWarm({ getBlockNumber: failing }, {});
    vi.advanceTimersByTime(1_600);
    await vi.advanceTimersByTimeAsync(0);
    expect(failing).toHaveBeenCalledTimes(1);
    stop();
  });
});
