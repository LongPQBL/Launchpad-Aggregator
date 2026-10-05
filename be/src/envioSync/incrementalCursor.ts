import { and, eq, gt, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { envioSyncCursors } from '../db/schema.js';

export const STREAMS = [
  'v1-launch', 'v1-swap', 'v2-launch', 'v2-curve', 'v2-buyback', 'v2-lifecycle', 'v4-initialize', 'v4-swap',
] as const;
export type Stream = typeof STREAMS[number];

export const LANES = ['tail', 'history'] as const;
export type Lane = typeof LANES[number];

export interface CursorKey { chainId: number; stream: Stream; lane: Lane }
export interface CursorPosition { blockNumber: bigint; logIndex: number; rawId: string }
export interface SyncCursor extends CursorKey {
  position: CursorPosition;
  processedWatermark: bigint | null;
  updatedAt: Date;
}

// Before any row from a stream has ever been applied. Real block numbers start above zero, so this
// sentinel compares below every genuine position without needing a nullable "first run" branch.
const GENESIS_POSITION: CursorPosition = { blockNumber: 0n, logIndex: -1, rawId: '' };

function whereKey(key: CursorKey) {
  return and(
    eq(envioSyncCursors.chainId, key.chainId),
    eq(envioSyncCursors.stream, key.stream),
    eq(envioSyncCursors.lane, key.lane),
  );
}

function toCursor(row: typeof envioSyncCursors.$inferSelect): SyncCursor {
  return {
    chainId: row.chainId, stream: row.stream as Stream, lane: row.lane as Lane,
    position: { blockNumber: row.blockNumber, logIndex: row.logIndex, rawId: row.rawId },
    processedWatermark: row.processedWatermark, updatedAt: row.updatedAt,
  };
}

/**
 * Returns the stream's durable cursor, creating it at the genesis position on first use.
 * `onConflictDoNothing` makes a concurrent first claim for the same key resolve to one row.
 */
export async function claimSyncCursor(appDb: DbOrTx, key: CursorKey): Promise<SyncCursor> {
  await appDb.insert(envioSyncCursors).values({
    chainId: key.chainId, stream: key.stream, lane: key.lane,
    blockNumber: GENESIS_POSITION.blockNumber, logIndex: GENESIS_POSITION.logIndex, rawId: GENESIS_POSITION.rawId,
    processedWatermark: null,
  }).onConflictDoNothing();
  const [row] = await appDb.select().from(envioSyncCursors).where(whereKey(key));
  if (!row) throw new Error(`Failed to claim sync cursor for chain ${key.chainId} stream ${key.stream} lane ${key.lane}`);
  return toCursor(row);
}

/**
 * Persists the stream's newly applied position and the Envio fence observed this pass. `position`
 * must never exceed `processedBlock` — the pass's own committed Envio fence — since a cursor past
 * what this pass actually read would silently claim coverage the sync never verified.
 */
export async function advanceSyncCursor(
  tx: DbOrTx, key: CursorKey, position: CursorPosition, processedBlock: bigint,
): Promise<void> {
  // A caller cut short by its own page limit legitimately reports a position one block ahead of
  // what it can confirm complete (it stopped mid-block, not knowing whether more rows at that same
  // block remain unread) — allow exactly that one-block gap, reject anything wider (final review,
  // Critical 3/Important 4).
  if (position.blockNumber > processedBlock + 1n) {
    throw new Error(`Cursor position block ${position.blockNumber} exceeds processed fence ${processedBlock} `
      + `for chain ${key.chainId} stream ${key.stream} lane ${key.lane}`);
  }
  const result = await tx.update(envioSyncCursors).set({
    blockNumber: position.blockNumber, logIndex: position.logIndex, rawId: position.rawId,
    processedWatermark: processedBlock, updatedAt: new Date(),
  }).where(whereKey(key));
  if (result.rowCount !== 1) {
    throw new Error(`Cannot advance an unclaimed sync cursor for chain ${key.chainId} stream ${key.stream} lane ${key.lane}`);
  }
}

/**
 * True when any stream/lane's recorded position or confirmed watermark is now ahead of `fence` —
 * Envio's own processed block has rolled back behind what a cursor already read. Left undetected,
 * the next regular pass's read range becomes empty (nothing is `<= fence` and `> position`) while
 * its position stays at the old, now-invalid value, so advanceSyncCursor's own guard throws on every
 * cycle until Envio happens to pass the old position again — repair never gets a chance to run while
 * the loop is stuck failing (final review, Important 8). Callers should run a repair pass immediately
 * on a true result, before resuming normal append ingestion.
 */
export async function detectEnvioRollback(appDb: DbOrTx, chainId: number, fence: bigint): Promise<boolean> {
  const [row] = await appDb.select({ blockNumber: envioSyncCursors.blockNumber }).from(envioSyncCursors)
    .where(and(eq(envioSyncCursors.chainId, chainId), or(gt(envioSyncCursors.blockNumber, fence), gt(envioSyncCursors.processedWatermark, fence))))
    .limit(1);
  return row !== undefined;
}
