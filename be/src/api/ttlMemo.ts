// Caches a promise per key for ttlMs. A rejected call is dropped so the next call retries.
// `invalidate(match, minAgeMs)` drops matching entries computed at least `minAgeMs` ago, for when the data behind them is known to have changed.
export type TtlMemo<K, V, A> = ((key: K, arg?: A) => Promise<V>) & { invalidate: (match: (key: K) => boolean, minAgeMs?: number) => void };

export function ttlMemo<K, V, A = undefined>(
  fn: (key: K, arg: A) => Promise<V>, ttlMs: number, now: () => number = Date.now,
): TtlMemo<K, V, A> {
  const entries = new Map<K, { value: Promise<V>; expiresAt: number }>();
  const read = (key: K, arg?: A) => {
    const current = entries.get(key);
    if (current && current.expiresAt > now()) return current.value;
    const value = fn(key, arg as A);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    return value;
  };
  const invalidate = (match: (key: K) => boolean, minAgeMs = 0) => {
    for (const [key, entry] of entries) if (match(key) && now() - (entry.expiresAt - ttlMs) >= minAgeMs) entries.delete(key);
  };
  return Object.assign(read, { invalidate });
}

/**
 * Like `ttlMemo`, but an entry older than `freshMs` (and younger than `staleMs`) is still returned immediately while one background refresh
 * replaces it; a failed refresh keeps serving the stale value until `staleMs` runs out. Past `staleMs`, or with no entry, the caller waits.
 * `invalidate(match, minAgeMs)` drops matching entries older than `minAgeMs` so the next caller waits for a recomputation: used when the
 * underlying data is known to have changed, and rate-limited by `minAgeMs` so a hot key is not recomputed on every change.
 */
export type SwrMemo<K, V, A> = ((key: K, arg?: A) => Promise<V>) & { invalidate: (match: (key: K) => boolean, minAgeMs?: number) => void };

export function swrMemo<K, V, A = undefined>(
  fn: (key: K, arg: A) => Promise<V>, freshMs: number, staleMs: number, now: () => number = Date.now,
): SwrMemo<K, V, A> {
  const entries = new Map<K, { value: Promise<V>; fetchedAt: number; refreshing: boolean }>();
  const read = (key: K, arg?: A) => {
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
  const invalidate = (match: (key: K) => boolean, minAgeMs = 0) => {
    for (const [key, entry] of entries) if (match(key) && now() - entry.fetchedAt >= minAgeMs) entries.delete(key);
  };
  return Object.assign(read, { invalidate });
}
