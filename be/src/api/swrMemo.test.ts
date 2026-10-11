import { describe, expect, it, vi } from 'vitest';
import { swrMemo } from './ttlMemo.js';

describe('swrMemo', () => {
  it('reuses a fresh value, serves a stale one at once while refreshing in the background, and waits only when there is nothing usable', async () => {
    let time = 0;
    let version = 0;
    const fn = vi.fn(async () => ++version);
    const memo = swrMemo(fn, 10, 100, () => time);
    expect(await memo('k')).toBe(1);
    time = 5;
    expect(await memo('k')).toBe(1);          // fresh: no new call
    expect(fn).toHaveBeenCalledTimes(1);
    time = 20;
    const [first, second] = [memo('k'), memo('k')]; // stale: both are served at once...
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);      // ...and only one refresh was started
    await Promise.resolve(); await Promise.resolve();
    expect(await memo('k')).toBe(2);          // the refreshed value is now served
    time = 500;
    expect(await memo('k')).toBe(3);          // too old: the caller waits for a new value
  });
  it('keeps serving the stale value when a background refresh fails, and drops a failed first load', async () => {
    let time = 0;
    let fail = false;
    const memo = swrMemo(async () => { if (fail) throw new Error('down'); return 'ok'; }, 10, 100, () => time);
    expect(await memo('k')).toBe('ok');
    fail = true; time = 20;
    expect(await memo('k')).toBe('ok');
    await Promise.resolve(); await Promise.resolve();
    expect(await memo('k')).toBe('ok');
    const first = swrMemo(async () => { throw new Error('nope'); }, 10, 100, () => 0);
    await expect(first('x')).rejects.toThrow('nope');
    await expect(first('x')).rejects.toThrow('nope'); // not cached: tried again
  });
});
