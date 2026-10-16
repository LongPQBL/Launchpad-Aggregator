import type { Pool } from 'pg';
import type { LogClass, WatchKind } from './decode.js';

export type WatchSet = Readonly<Record<WatchKind, ReadonlySet<string>>>;
export const EMPTY_WATCH_SET: WatchSet = { curve: new Set(), v2_pool: new Set(), v3_pool: new Set(), v4_pool: new Set(), lifecycle_factory: new Set() };

export interface WatchedVenue { id: string; kind: WatchKind; ref: string; sourceId: string; confirmedToBlock: bigint; official: boolean }
export type WatchSetSnapshot = WatchSet & { addedVenues: readonly WatchedVenue[] };

type MutableWatchSet = Record<WatchKind, Set<string>>;
interface VenueRow { id: string; kind: WatchKind; ref: string; source_id: string; confirmed_to_block: string; official: boolean; seq: string }

function emptySets(): MutableWatchSet {
  return { curve: new Set(), v2_pool: new Set(), v3_pool: new Set(), v4_pool: new Set(), lifecycle_factory: new Set() };
}

const WATCH_SQL = `SELECT v.id, v.kind, v.ref, v.source_id, s.confirmed_to_block, v.official, v.seq
  FROM venues v JOIN sources s ON s.id = v.source_id
  WHERE v.chain_id = $1 AND v.kind IN ('curve', 'v3_pool', 'v4_pool')`;
const CATALOG_SQL = `SELECT protocol, pool_id FROM pool_catalog
  WHERE chain_id = $1 AND verified = true AND protocol IN ('uniswap_v2', 'uniswap_v3', 'uniswap_v4')`;
const FACTORY_SQL = `SELECT DISTINCT factory_address FROM sources WHERE chain_id = $1 AND version = 'v2'`;

function addCatalogPools(sets: MutableWatchSet, rows: readonly { protocol: string; pool_id: string }[]): void {
  for (const row of rows) {
    const kind = row.protocol === 'uniswap_v2' ? 'v2_pool' : row.protocol === 'uniswap_v3' ? 'v3_pool' : 'v4_pool';
    sets[kind].add(row.pool_id.toLowerCase());
  }
}

/** The venues a trade log can belong to: bonding curves, V3 pools and V4 pool ids that launches already have in the database. */
export async function loadWatchSet(pool: Pool, chainId: number): Promise<WatchSet> {
  const sets = emptySets();
  const result = await pool.query(WATCH_SQL, [chainId]);
  for (const row of result.rows as VenueRow[]) sets[row.kind].add(row.ref.toLowerCase());
  const catalog = await pool.query(CATALOG_SQL, [chainId]);
  addCatalogPools(sets, catalog.rows);
  const factories = await pool.query(FACTORY_SQL, [chainId]);
  for (const row of factories.rows) sets.lifecycle_factory.add(String(row.factory_address).toLowerCase());
  return sets;
}

// A venue inserted by a transaction that committed after a later one (its seq is lower than one already read) would be missed by "seq > last";
// reading this many rows back makes that harmless, and the full reload below catches anything older.
const OVERLAP = 2_000n;

export interface WatchSetLoader {
  /** The first call, and every `fullReloadEveryMs` after, reads every venue; the others read only the venues added since. */
  refresh(): Promise<WatchSetSnapshot>;
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
      const next = full ? emptySets() : { curve: new Set(sets.curve), v2_pool: new Set(sets.v2_pool), v3_pool: new Set(sets.v3_pool),
        v4_pool: new Set(sets.v4_pool), lifecycle_factory: new Set(sets.lifecycle_factory) };
      const addedVenues: WatchedVenue[] = [];
      for (const row of result.rows as VenueRow[]) {
        const ref = row.ref.toLowerCase();
        if (!next[row.kind].has(ref)) addedVenues.push({
          id: row.id, kind: row.kind, ref, sourceId: row.source_id, confirmedToBlock: BigInt(row.confirmed_to_block), official: row.official,
        });
        next[row.kind].add(ref);
        const seq = BigInt(row.seq);
        if (seq > highestSeq) highestSeq = seq;
      }
      const catalog = await pool.query(CATALOG_SQL, [chainId]);
      addCatalogPools(next, catalog.rows);
      const factories = await pool.query(FACTORY_SQL, [chainId]);
      for (const row of factories.rows) next.lifecycle_factory.add(String(row.factory_address).toLowerCase());
      sets = next;
      if (full) lastFullAt = now();
      return { ...sets, addedVenues };
    },
  };
}

export function isWatched(set: WatchSet, cls: Pick<LogClass, 'watchKind' | 'watchRef'>): boolean {
  return set[cls.watchKind].has(cls.watchRef);
}
