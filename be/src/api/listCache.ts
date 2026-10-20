import type { ApiEventBus } from './events.js';
import type { ApiDeps } from './server.js';

type Data = ApiDeps['data'];

const MAX_ENTRIES = 64;
const MIN_RECOMPUTE_MS = 500;
const TRANSACTIONS_TTL_MS = 2_000;

/**
 * Many browsers refetch the same first page of the launch list right after one announced change. Sharing one computation among them
 * keeps that herd off the database. An entry lives `ttlMs` and is dropped by an announced change that is older than half a second,
 * so a refetch that an announcement triggers reads fresh data unless the list was just computed. Paged and searched requests are not cached.
 */
export function withLaunchListCache(data: Data, events?: ApiEventBus, ttlMs = 1_000, now: () => number = Date.now): Data {
  // Without an event bus nothing would ever invalidate an entry early, so there is no cache at all.
  if (!events) return data;
  const entries = new Map<string, { at: number; value: ReturnType<Data['listLaunches']> }>();
  // A trade by itself changes nothing the list reads (its figures are recomputed afterwards and announced as launch.changed). An entry
  // computed within MIN_RECOMPUTE_MS survives the announcement, which bounds a hot variant to two computations a second; a browser's
  // trailing refetch a second later reads fresh data.
  events.subscribe((event) => {
    if (event.type !== 'launch.changed' && event.type !== 'coverage.changed') return;
    for (const [key, entry] of entries) if (now() - entry.at >= MIN_RECOMPUTE_MS) entries.delete(key);
  });
  // A token's page shows its newest transactions and every open browser refetches them on each trade; the busiest tokens take seconds to compute (their
  // pools' swaps are merged in), so the first page is shared for a couple of seconds. Paged requests are not cached.
  const transactionEntries = new Map<string, { at: number; value: ReturnType<Data['listTransactions']> }>();
  return {
    ...data,
    listTransactions(chainId, tokenAddress, query) {
      if (query.cursor) return data.listTransactions(chainId, tokenAddress, query);
      const key = JSON.stringify([chainId, tokenAddress.toLowerCase(), query]);
      const hit = transactionEntries.get(key);
      if (hit && now() - hit.at < TRANSACTIONS_TTL_MS) return hit.value;
      const value = data.listTransactions(chainId, tokenAddress, query);
      if (transactionEntries.size >= MAX_ENTRIES) transactionEntries.delete(transactionEntries.keys().next().value as string);
      transactionEntries.set(key, { at: now(), value });
      value.catch(() => { if (transactionEntries.get(key)?.value === value) transactionEntries.delete(key); });
      return value;
    },
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
