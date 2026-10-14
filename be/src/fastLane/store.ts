import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows, fastLaneState, trades } from '../db/schema.js';
import type { LiveEntry } from '../envioSync/incrementalSync.js';
import { notifyChanged } from '../envioSync/notifyChanges.js';
import { invalidateLaunchVolume } from '../market/launchVolume/store.js';

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

export async function advanceLaneBlock(db: Database, chainId: number, block: bigint): Promise<void> {
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
    )).returning({ tokenAddress: trades.tokenAddress });
    if (deleted.length === 0) return false;
    await tx.delete(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, txHash), eq(fastLaneRows.logIndex, key.logIndex)));
    const launchKeys = [...new Set(deleted.map((row) => row.tokenAddress))].map((tokenAddress) => ({ chainId, tokenAddress }));
    await invalidateLaunchVolume(tx, launchKeys, new Date());
    await notifyChanged(tx, launchKeys.map((launch) => ({ kind: 'launch.changed' as const, chainId, tokenAddress: launch.tokenAddress })));
    return true;
  });
}
