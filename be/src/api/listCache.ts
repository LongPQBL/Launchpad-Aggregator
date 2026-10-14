import type { ApiEventBus } from './events.js';
import type { ApiDeps } from './server.js';

type Data = ApiDeps['data'];

const MAX_ENTRIES = 64;

/**
 * Many browsers refetch the same first page of the launch list right after one announced change. Sharing one computation among them
 * keeps that herd off the database. An entry lives `ttlMs` and is dropped by any event that changes what the list shows, so a refetch
 * that an announcement triggers never reads a result computed before it. Paged and searched requests are not cached.
 */
export function withLaunchListCache(data: Data, events?: ApiEventBus, ttlMs = 1_000, now: () => number = Date.now): Data {
  // Without an event bus nothing would ever invalidate an entry early, so there is no cache at all.
  if (!events) return data;
  const entries = new Map<string, { at: number; value: ReturnType<Data['listLaunches']> }>();
  events.subscribe((event) => {
    if (event.type === 'launch.changed' || event.type === 'trade.created' || event.type === 'coverage.changed') entries.clear();
  });
  return {
    ...data,
    listLaunches(query) {
      if (query.cursor || query.search) return data.listLaunches(query);
      const key = JSON.stringify(query);
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = data.listLaunches(query);
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      entries.set(key, { at: now(), value });
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      return value;
    },
  };
}
