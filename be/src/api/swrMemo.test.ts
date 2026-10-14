import { describe, expect, it, vi } from 'vitest';
import { swrMemo, ttlMemo } from './ttlMemo.js';

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
  it('invalidate drops matching entries older than the minimum age so the next caller recomputes', async () => {
    let time = 0;
    let calls = 0;
    const memo = swrMemo(async (key: string) => `${key}:${++calls}`, 10, 100, () => time);
    expect(await memo('a')).toBe('a:1');
    expect(await memo('b')).toBe('b:2');
    time = 5;
    memo.invalidate((key) => key === 'a', 1_000); // too young: kept
    expect(await memo('a')).toBe('a:1');
    memo.invalidate((key) => key === 'a', 3); // old enough: dropped, the caller waits for a fresh value
    expect(await memo('a')).toBe('a:3');
    expect(await memo('b')).toBe('b:2'); // not matched: untouched
  });
});

describe('ttlMemo invalidate', () => {
  it('drops matching entries computed at least the minimum age ago', async () => {
    let time = 0;
    let calls = 0;
    const memo = ttlMemo(async (key: string) => `${key}:${++calls}`, 1_000, () => time);
    expect(await memo('a:x')).toBe('a:x:1');
    expect(await memo('b:x')).toBe('b:x:2');
    time = 100;
    memo.invalidate((key) => key.startsWith('a:'), 250); // too young: kept
    expect(await memo('a:x')).toBe('a:x:1');
    time = 300;
    memo.invalidate((key) => key.startsWith('a:'), 250);
    expect(await memo('a:x')).toBe('a:x:3');
    expect(await memo('b:x')).toBe('b:x:2');
  });
});
