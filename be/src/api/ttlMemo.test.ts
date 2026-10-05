import { describe, expect, it, vi } from 'vitest';
import { ttlMemo } from './ttlMemo.js';

describe('ttlMemo', () => {
  it('returns the cached result for the same key within the TTL', async () => {
    const fn = vi.fn(async (key: string) => `value-${key}`);
    const memo = ttlMemo(fn, 60_000, () => 0);
    expect(await memo('a')).toBe('value-a');
    expect(await memo('a')).toBe('value-a');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls the function again once the TTL has passed', async () => {
    let now = 0;
    const fn = vi.fn(async (key: string) => `value-${key}`);
    const memo = ttlMemo(fn, 60_000, () => now);
    await memo('a');
    now = 60_001;
    await memo('a');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps different keys separate and does not cache a rejected call', async () => {
    let fail = true;
    const fn = vi.fn(async (key: string) => {
      if (fail) throw new Error('rpc down');
      return `value-${key}`;
    });
    const memo = ttlMemo(fn, 60_000, () => 0);
    await expect(memo('a')).rejects.toThrow('rpc down');
    fail = false;
    expect(await memo('a')).toBe('value-a');
    expect(await memo('b')).toBe('value-b');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
