import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows, fastLaneState, fastLaneVenueCoverage, trades } from '../db/schema.js';
import type { LiveEntry } from '../envioSync/incrementalSync.js';
import { notifyChanged } from '../envioSync/notifyChanges.js';
import { invalidateLaunchVolume } from '../market/launchVolume/store.js';
import { invalidateCurveReserve } from '../market/curvePricing.js';
import type { WatchedVenue } from './watchSet.js';

const CURVE_EVENTS = new Set(['CurveBuy', 'CurveSell', 'BuybackLocked']);

/** Remembers which rows the lane wrote, with the raw row it fed in, until the parity command has compared them with Envio's. */
export async function recordFastRows(db: Database, chainId: number, entries: readonly LiveEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(fastLaneRows).values(entries.map((entry) => ({
    chainId, txHash: String(entry.raw.txHash).toLowerCase(), logIndex: Number(entry.raw.logIndex), stream: entry.stream,
    raw: entry.raw, blockNumber: BigInt(String(entry.raw.blockNumber)),
  }))).onConflictDoNothing();
}

export async function readLaneBlock(db: Database, chainId: number): Promise<bigint | null> {
  const [row] = await db.select().from(fastLaneState).where(eq(fastLaneState.chainId, chainId));
  return row?.lastBlock ?? null;
}

export async function readMinimumLaneBridgeBlock(db: Database, chainId: number): Promise<bigint | null> {
  const [row] = await db.select({ block: sql<string | null>`min(${fastLaneVenueCoverage.envioBridgeBlock})` })
    .from(fastLaneVenueCoverage).where(eq(fastLaneVenueCoverage.chainId, chainId));
  return row?.block === null || row?.block === undefined ? null : BigInt(row.block);
}

/** Add a coverage bridge for each venue as it enters the watch set. A venue added after a sweep requires Envio to bridge through
 * the lane cursor first, because the lane could not have seen its earlier trades. */
export async function ensureLaneVenueCoverage(db: Database, chainId: number, venues: readonly WatchedVenue[], laneBlock: bigint | null): Promise<void> {
  const official = venues.filter((venue) => venue.official);
  if (official.length === 0) return;
  await db.insert(fastLaneVenueCoverage).values(official.map((venue) => ({
    chainId, venueId: venue.id,
    envioBridgeBlock: laneBlock !== null && laneBlock > venue.confirmedToBlock ? laneBlock : venue.confirmedToBlock,
  }))).onConflictDoNothing();
}

export async function raiseLaneVenueBridge(db: Database, chainId: number, block: bigint): Promise<void> {
  await db.update(fastLaneVenueCoverage).set({
    envioBridgeBlock: sql`GREATEST(${fastLaneVenueCoverage.envioBridgeBlock}, ${block})`, updatedAt: new Date(),
  }).where(eq(fastLaneVenueCoverage.chainId, chainId));
}

/** Initializes both cursors at an Envio-confirmed fence; the combined source union is complete through this block. */
export async function initializeLaneBlock(db: Database, chainId: number, block: bigint): Promise<void> {
  await db.insert(fastLaneState).values({ chainId, lastBlock: block, coverageBlock: block }).onConflictDoNothing();
}

export async function advanceLaneBlock(db: Database, chainId: number, block: bigint): Promise<void> {
  await db.insert(fastLaneState).values({ chainId, lastBlock: block }).onConflictDoUpdate({
    target: fastLaneState.chainId,
    set: {
      lastBlock: sql`GREATEST(${fastLaneState.lastBlock}, excluded.last_block)`,
      coverageBlock: sql`GREATEST(COALESCE(${fastLaneState.coverageBlock}, excluded.last_block), excluded.last_block)`, updatedAt: new Date(),
    },
  });
}

/** Advances only the restart cursor after a gap too large to scan; coverageBlock must remain unchanged. */
export async function advanceLaneResumeBlock(db: Database, chainId: number, block: bigint): Promise<void> {
  await db.insert(fastLaneState).values({ chainId, lastBlock: block }).onConflictDoUpdate({
    target: fastLaneState.chainId,
    set: { lastBlock: sql`GREATEST(${fastLaneState.lastBlock}, excluded.last_block)`, updatedAt: new Date() },
  });
}

/**
 * The node reported a log as removed (its block was reorganised away): delete the trade written for exactly that block, forget its
 * bookkeeping, and tell the launch's pages. A row for the same event under a different block hash is a replacement and is left alone.
 */
export async function removeLaneTrade(db: Database, chainId: number, key: { txHash: string; logIndex: number; blockHash: string }): Promise<boolean> {
  const txHash = key.txHash.toLowerCase();
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(trades).where(and(
      eq(trades.chainId, chainId), eq(trades.txHash, txHash), eq(trades.logIndex, key.logIndex),
      sql`lower(${trades.blockHash}) = ${key.blockHash.toLowerCase()}`,
    )).returning({ tokenAddress: trades.tokenAddress, sourceEvent: trades.sourceEvent });
    if (deleted.length === 0) return false;
    await tx.delete(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, txHash), eq(fastLaneRows.logIndex, key.logIndex)));
    const launchKeys = [...new Set(deleted.map((row) => row.tokenAddress))].map((tokenAddress) => ({ chainId, tokenAddress }));
    await invalidateLaunchVolume(tx, launchKeys, new Date());
    // The replay's checkpoint may already include the deleted trade: drop it so the next tick re-derives it (repair does the same).
    const curveLaunches = [...new Set(deleted.filter((row) => CURVE_EVENTS.has(row.sourceEvent)).map((row) => row.tokenAddress))];
    await invalidateCurveReserve(tx, curveLaunches.map((tokenAddress) => ({ chainId, tokenAddress })));
    await notifyChanged(tx, launchKeys.map((launch) => ({ kind: 'launch.changed' as const, chainId, tokenAddress: launch.tokenAddress })));
    return true;
  });
}
