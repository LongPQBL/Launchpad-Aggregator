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

/**
 * Like `ttlMemo`, but an entry older than `freshMs` (and younger than `staleMs`) is still returned immediately while one background refresh
 * replaces it; a failed refresh keeps serving the stale value until `staleMs` runs out. Past `staleMs`, or with no entry, the caller waits.
 */
export function swrMemo<K, V, A = undefined>(
  fn: (key: K, arg: A) => Promise<V>, freshMs: number, staleMs: number, now: () => number = Date.now,
): (key: K, arg?: A) => Promise<V> {
  const entries = new Map<K, { value: Promise<V>; fetchedAt: number; refreshing: boolean }>();
  return (key: K, arg?: A) => {
    const current = entries.get(key);
    const age = current ? now() - current.fetchedAt : Number.POSITIVE_INFINITY;
    if (current && age < freshMs) return current.value;
    if (current && age < staleMs) {
      if (!current.refreshing) {
        current.refreshing = true;
        fn(key, arg as A).then(
          (value) => { entries.set(key, { value: Promise.resolve(value), fetchedAt: now(), refreshing: false }); },
          () => { current.refreshing = false; },
        );
      }
      return current.value;
    }
    const value = fn(key, arg as A);
    entries.set(key, { value, fetchedAt: now(), refreshing: false });
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    return value;
  };
}
