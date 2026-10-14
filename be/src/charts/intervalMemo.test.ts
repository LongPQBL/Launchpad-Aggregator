import { describe, expect, it } from 'vitest';
import { intervalTtlMemo } from './intervalMemo.js';

describe('intervalTtlMemo', () => {
  it('reuses the answer for the same key and interval, and keeps intervals apart', async () => {
    let calls = 0;
    const memo = intervalTtlMemo(async (_key: string, arg: { interval: number }) => ({ n: ++calls, interval: arg.interval }), (arg) => arg.interval);
    const first = await memo('a', { interval: 60 });
    expect(await memo('a', { interval: 60 })).toBe(first);
    expect((await memo('b', { interval: 60 })).n).toBe(2);
    expect((await memo('a', { interval: 86_400 })).n).toBe(3);
    expect(await memo('a', { interval: 86_400 })).toMatchObject({ n: 3 });
  });

  it('invalidates matching keys across every interval', async () => {
    let calls = 0;
    const memo = intervalTtlMemo(async (_key: string, arg: { interval: number }) => ({ n: ++calls, interval: arg.interval }), (arg) => arg.interval);
    await memo('4663:0xaa:60', { interval: 60 });
    await memo('4663:0xaa:86400', { interval: 86_400 });
    await memo('4663:0xbb:60', { interval: 60 });
    memo.invalidate((key) => key.startsWith('4663:0xaa:'));
    expect((await memo('4663:0xaa:60', { interval: 60 })).n).toBe(4);
    expect((await memo('4663:0xaa:86400', { interval: 86_400 })).n).toBe(5);
    expect((await memo('4663:0xbb:60', { interval: 60 })).n).toBe(3);
  });
});
