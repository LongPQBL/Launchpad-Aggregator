// Caches a promise per key for ttlMs. A rejected call is dropped so the next call retries.
export function ttlMemo<K, V, A = undefined>(
  fn: (key: K, arg: A) => Promise<V>, ttlMs: number, now: () => number = Date.now,
): (key: K, arg?: A) => Promise<V> {
  const entries = new Map<K, { value: Promise<V>; expiresAt: number }>();
  return (key: K, arg?: A) => {
    const current = entries.get(key);
    if (current && current.expiresAt > now()) return current.value;
    const value = fn(key, arg as A);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    return value;
  };
}
