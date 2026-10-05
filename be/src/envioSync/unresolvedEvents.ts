import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { unresolvedEvents } from '../db/schema.js';
import type { Stream } from './incrementalCursor.js';

export interface UnresolvedEventKey { chainId: number; stream: Stream; rawId: string }

/** Durably records a row `applyEnvioPage` could not apply, so it survives past the moving cursor. */
export async function enqueueUnresolvedEvent(
  tx: DbOrTx, input: UnresolvedEventKey & { reason: string; blockNumber: bigint },
): Promise<void> {
  await tx.insert(unresolvedEvents).values({
    chainId: input.chainId, stream: input.stream, rawId: input.rawId, reason: input.reason, blockNumber: input.blockNumber,
  }).onConflictDoNothing();
}

export interface ClaimedUnresolvedEvent extends UnresolvedEventKey {
  reason: string;
  retryCount: number;
}

/** The lowest block among a stream's still-unresolved events, or null if none — see schema.ts's comment on unresolvedEvents.blockNumber. */
export async function earliestUnresolvedBlock(db: DbOrTx, chainId: number, stream: Stream): Promise<bigint | null> {
  const [row] = await db.select({ blockNumber: unresolvedEvents.blockNumber }).from(unresolvedEvents)
    .where(and(eq(unresolvedEvents.chainId, chainId), eq(unresolvedEvents.stream, stream)))
    .orderBy(unresolvedEvents.blockNumber).limit(1);
  return row?.blockNumber ?? null;
}

/** Due rows for one stream, oldest first. A single retry worker is assumed — no row locking. */
export async function claimDueUnresolvedEvents(
  db: DbOrTx, chainId: number, stream: Stream, now: Date, limit: number,
): Promise<ClaimedUnresolvedEvent[]> {
  const rows = await db.select().from(unresolvedEvents).where(and(
    eq(unresolvedEvents.chainId, chainId), eq(unresolvedEvents.stream, stream),
    or(isNull(unresolvedEvents.nextRetryAt), lte(unresolvedEvents.nextRetryAt, now)),
  )).orderBy(unresolvedEvents.createdAt).limit(limit);
  return rows.map((row) => ({
    chainId: row.chainId, stream: row.stream as Stream, rawId: row.rawId, reason: row.reason, retryCount: row.retryCount,
  }));
}

const RETRY_CAP_SECONDS = 3600;
function nextUnresolvedRetryAt(now: Date, retryCount: number): Date {
  return new Date(now.getTime() + Math.min(60 * 2 ** Math.min(retryCount, 6), RETRY_CAP_SECONDS) * 1000);
}

/** Removes a resolved event, or reschedules it with exponential backoff if still unresolved. */
export async function settleUnresolvedEvent(tx: DbOrTx, key: UnresolvedEventKey, resolved: boolean, now: Date, retryCount: number): Promise<void> {
  const where = and(eq(unresolvedEvents.chainId, key.chainId), eq(unresolvedEvents.stream, key.stream), eq(unresolvedEvents.rawId, key.rawId));
  if (resolved) {
    await tx.delete(unresolvedEvents).where(where);
    return;
  }
  await tx.update(unresolvedEvents).set({ retryCount: retryCount + 1, nextRetryAt: nextUnresolvedRetryAt(now, retryCount) }).where(where);
}
