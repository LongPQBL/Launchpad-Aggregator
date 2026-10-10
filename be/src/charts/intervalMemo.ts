import { ttlMemo } from '../api/ttlMemo.js';
import { historyTtlMs } from './ranges.js';

/** ttlMemo whose lifetime depends on the bucket size of the request: 1-minute charts stay fresh, yearly ones are reused longer. */
export function intervalTtlMemo<V, A>(
  fn: (key: string, arg: A) => Promise<V>, intervalOf: (arg: A) => number,
): (key: string, arg: A) => Promise<V> {
  const byTtl = new Map<number, (key: string, arg?: A) => Promise<V>>();
  return (key, arg) => {
    const ttl = historyTtlMs(intervalOf(arg));
    let memo = byTtl.get(ttl);
    if (!memo) { memo = ttlMemo(fn, ttl); byTtl.set(ttl, memo); }
    return memo(key, arg);
  };
}
