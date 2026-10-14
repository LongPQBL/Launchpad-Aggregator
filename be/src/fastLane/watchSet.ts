import type { Pool } from 'pg';
import type { LogClass, WatchKind } from './decode.js';

export type WatchSet = Readonly<Record<WatchKind, ReadonlySet<string>>>;
export const EMPTY_WATCH_SET: WatchSet = { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };

/** The venues a trade log can belong to: bonding curves, V3 pools and V4 pool ids that launches already have in the database. */
export async function loadWatchSet(pool: Pool, chainId: number): Promise<WatchSet> {
  const result = await pool.query(`SELECT kind, ref FROM venues WHERE chain_id = $1 AND kind IN ('curve', 'v3_pool', 'v4_pool')`, [chainId]);
  const sets: Record<WatchKind, Set<string>> = { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };
  for (const row of result.rows as { kind: WatchKind; ref: string }[]) sets[row.kind].add(row.ref.toLowerCase());
  return sets;
}

export function isWatched(set: WatchSet, cls: Pick<LogClass, 'watchKind' | 'watchRef'>): boolean {
  return set[cls.watchKind].has(cls.watchRef);
}
