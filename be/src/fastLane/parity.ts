import type { Pool } from 'pg';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows, trades } from '../db/schema.js';
import { readRawRowByTxLog } from '../envioSync/incrementalPage.js';
import { DEFAULT_STREAM_TABLES, type LiveStream } from '../envioSync/incrementalSync.js';

export interface ParityMismatch { txHash: string; logIndex: number; stream: string; fields: { field: string; lane: string; envio: string }[] }
export interface ParityReport {
  checked: number; matching: number; mismatched: ParityMismatch[]; missingInEnvio: { txHash: string; logIndex: number; stream: string }[]; pending: number;
  /** Rows whose trade was already removed (repair, reconcile or a reorg notice): their bookkeeping is dropped. */
  repaired: number;
}
export interface ParityOptions {
  chainId: number; olderThanSeconds: number; processedBlock: bigint; tables?: Partial<Record<LiveStream, string>>; limit?: number;
}

const norm = (value: unknown) => String(value).toLowerCase();

/**
 * Compares the raw rows the fast lane fed in with the rows Envio produced for the same event. Equal raw rows give equal trades because both go
 * through the same `applyRow`; this is the guard against the lane's decoder drifting from Envio's handler.
 */
export async function runParity(appDb: Database, envioPool: Pool, options: ParityOptions): Promise<ParityReport> {
  const tables = { ...DEFAULT_STREAM_TABLES, ...options.tables };
  const cutoff = new Date(Date.now() - options.olderThanSeconds * 1000);
  const all = await appDb.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, options.chainId))
    .orderBy(asc(fastLaneRows.writtenAt)).limit(options.limit ?? 5_000);
  const report: ParityReport = { checked: 0, matching: 0, mismatched: [], missingInEnvio: [], pending: 0, repaired: 0 };
  const forget = (row: typeof all[number]) => appDb.delete(fastLaneRows)
    .where(and(eq(fastLaneRows.chainId, options.chainId), eq(fastLaneRows.txHash, row.txHash), eq(fastLaneRows.logIndex, row.logIndex)));
  for (const row of all) {
    if (row.writtenAt >= cutoff || row.blockNumber > options.processedBlock) { report.pending += 1; continue; }
    const [trade] = await appDb.select({ txHash: trades.txHash }).from(trades)
      .where(and(eq(trades.chainId, options.chainId), eq(trades.txHash, row.txHash), eq(trades.logIndex, row.logIndex))).limit(1);
    if (!trade) { report.repaired += 1; await forget(row); continue; }
    report.checked += 1;
    const envio = await readRawRowByTxLog(envioPool, tables[row.stream as LiveStream], options.chainId, row.txHash, row.logIndex);
    if (!envio) { report.missingInEnvio.push({ txHash: row.txHash, logIndex: row.logIndex, stream: row.stream }); continue; }
    const fields = Object.entries(row.raw)
      .filter(([field]) => field !== 'id')
      .filter(([field, value]) => norm(value) !== norm(envio[field]))
      .map(([field, value]) => ({ field, lane: String(value), envio: String(envio[field]) }));
    if (fields.length > 0) { report.mismatched.push({ txHash: row.txHash, logIndex: row.logIndex, stream: row.stream, fields }); continue; }
    report.matching += 1;
    await forget(row);
  }
  return report;
}
