import type { Pool } from 'pg';
import type { LogClass, WatchKind } from './decode.js';

export type WatchSet = Readonly<Record<WatchKind, ReadonlySet<string>>>;
export const EMPTY_WATCH_SET: WatchSet = { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };

type MutableWatchSet = Record<WatchKind, Set<string>>;
interface VenueRow { kind: WatchKind; ref: string; seq: string }

function emptySets(): MutableWatchSet {
  return { curve: new Set(), v3_pool: new Set(), v4_pool: new Set() };
}

const WATCH_SQL = `SELECT kind, ref, seq FROM venues WHERE chain_id = $1 AND kind IN ('curve', 'v3_pool', 'v4_pool')`;

/** The venues a trade log can belong to: bonding curves, V3 pools and V4 pool ids that launches already have in the database. */
export async function loadWatchSet(pool: Pool, chainId: number): Promise<WatchSet> {
  const sets = emptySets();
  const result = await pool.query(WATCH_SQL, [chainId]);
  for (const row of result.rows as VenueRow[]) sets[row.kind].add(row.ref.toLowerCase());
  return sets;
}

// A venue inserted by a transaction that committed after a later one (its seq is lower than one already read) would be missed by "seq > last";
// reading this many rows back makes that harmless, and the full reload below catches anything older.
const OVERLAP = 2_000n;

export interface WatchSetLoader {
  /** The first call, and every `fullReloadEveryMs` after, reads every venue; the others read only the venues added since. */
  refresh(): Promise<WatchSet>;
}

/**
 * Keeps the watch set up to date without re-reading all venues (about 167k rows) on every refresh. Venues are only ever added during
 * normal operation, so a refresh reads the rows past the highest `seq` seen (minus an overlap). A venue that was deleted (a reorg repair)
 * stays in the set until the next full reload; that is harmless, because a trade for it finds no venue and is dropped.
 */
export function createWatchSetLoader(pool: Pool, chainId: number, options: { fullReloadEveryMs?: number; now?: () => number } = {}): WatchSetLoader {
  const fullReloadEveryMs = options.fullReloadEveryMs ?? 600_000;
  const now = options.now ?? Date.now;
  let sets = emptySets();
  let highestSeq = 0n;
  let lastFullAt: number | null = null;

  return {
    async refresh() {
      const full = lastFullAt === null || now() - lastFullAt >= fullReloadEveryMs;
      const result = full
        ? await pool.query(WATCH_SQL, [chainId])
        : await pool.query(`${WATCH_SQL} AND seq > $2`, [chainId, (highestSeq > OVERLAP ? highestSeq - OVERLAP : 0n).toString()]);
      // Build the replacement off to the side and swap it in, so the log path never sees a half-filled set.
      const next = full ? emptySets() : { curve: new Set(sets.curve), v3_pool: new Set(sets.v3_pool), v4_pool: new Set(sets.v4_pool) };
      for (const row of result.rows as VenueRow[]) {
        next[row.kind].add(row.ref.toLowerCase());
        const seq = BigInt(row.seq);
        if (seq > highestSeq) highestSeq = seq;
      }
      sets = next;
      if (full) lastFullAt = now();
      return sets;
    },
  };
}

export function isWatched(set: WatchSet, cls: Pick<LogClass, 'watchKind' | 'watchRef'>): boolean {
  return set[cls.watchKind].has(cls.watchRef);
}
