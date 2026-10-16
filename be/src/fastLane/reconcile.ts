import type { Pool } from 'pg';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fastLaneRows } from '../db/schema.js';
import { readRawRowByTxLog } from '../envioSync/incrementalPage.js';
import { applyLiveRows, DEFAULT_STREAM_TABLES, type LiveStream } from '../envioSync/incrementalSync.js';
import { removeLaneTrade } from './store.js';
import { applyLivePoolEntries } from './poolStore.js';
import { v2SqrtPriceX96 } from '../pools/syncV3V2Pools.js';

export interface ReconcileOptions {
  chainId: number;
  /** Envio's processed block (its fence): only rows at or below it can be judged. */
  processedBlock: bigint;
  /** Rows written more recently than this are left alone. */
  olderThanSeconds: number;
  tables?: Partial<Record<LiveStream | 'v3-pool-swap' | 'v2-pool-swap', string>>;
  limit?: number;
}
export interface ReconcileReport {
  /** Rows Envio has with the same block hash: left for the parity command. */
  kept: number;
  /** Lane trades deleted because Envio has no such event, or has it in another block. */
  removed: number;
  /** Envio's row re-applied after the lane's copy from another block was deleted. */
  replaced: number;
  /** Bookkeeping rows dropped whose lane trade was already gone or already replaced. */
  forgotten: number;
  /** Rows too young or above Envio's processed block. */
  pending: number;
}

const lower = (value: unknown) => String(value).toLowerCase();

/**
 * Removes trades the fast lane wrote for a block that is no longer canonical, when the node never said so (a sweep row comes over HTTP, a
 * socket can drop a `removed` notice) and the periodic repair window has moved past it. Works only from `fast_lane_rows`, so it never
 * touches a trade the lane did not write. For each row at or below Envio's processed block and older than the safety age:
 * - Envio has the same event with the same block hash: kept (parity compares it later).
 * - Envio has no such event: the lane's trade (matched by the lane's own block hash) is deleted, with the same invalidations repair does.
 * - Envio has it under another block hash: the lane's copy is deleted and Envio's row is applied in its place — the app's insert ignores a
 *   conflict, so Envio's own pass could not have replaced it.
 */
export async function reconcileLaneRows(appDb: Database, envioPool: Pool, options: ReconcileOptions): Promise<ReconcileReport> {
  const tables = { ...DEFAULT_STREAM_TABLES, 'v3-pool-swap': 'envio."RawV3Swap"', 'v2-pool-swap': 'envio."RawV2Swap"', ...options.tables };
  const cutoff = new Date(Date.now() - options.olderThanSeconds * 1000);
  const rows = await appDb.select().from(fastLaneRows).where(eq(fastLaneRows.chainId, options.chainId))
    .orderBy(asc(fastLaneRows.writtenAt)).limit(options.limit ?? 1_000);
  const report: ReconcileReport = { kept: 0, removed: 0, replaced: 0, forgotten: 0, pending: 0 };
  for (const row of rows) {
    if (row.writtenAt >= cutoff || row.blockNumber > options.processedBlock) { report.pending += 1; continue; }
    const stream = row.stream as LiveStream | 'v3-pool-swap' | 'v2-pool-swap';
    const laneBlockHash = lower(row.raw.blockHash);
    const envio = await readRawRowByTxLog(envioPool, tables[stream], options.chainId, row.txHash, row.logIndex);
    if (envio && lower(envio.blockHash) === laneBlockHash) { report.kept += 1; continue; }
    const deleted = await removeLaneTrade(appDb, options.chainId, { txHash: row.txHash, logIndex: row.logIndex, blockHash: laneBlockHash });
    if (deleted) report.removed += 1;
    else {
      await appDb.delete(fastLaneRows).where(and(
        eq(fastLaneRows.chainId, options.chainId), eq(fastLaneRows.txHash, row.txHash), eq(fastLaneRows.logIndex, row.logIndex)));
      report.forgotten += 1;
    }
    if (envio && deleted) {
      const launchResult = stream === 'v3-pool-swap' || stream === 'v2-pool-swap' ? null : await applyLiveRows(appDb, options.chainId, [{ stream, raw: envio }]);
      let poolRaw = envio;
      if (stream === 'v2-pool-swap') {
        const sync = await envioPool.query(`SELECT "reserve0", "reserve1" FROM envio."RawV2Sync"
          WHERE "chainId"=$1 AND "pairAddress"=$2 AND "txHash"=$3 AND "logIndex" < $4
          ORDER BY "logIndex" DESC LIMIT 1`, [options.chainId, String(envio.pairAddress).toLowerCase(), envio.txHash, envio.logIndex]);
        const pair = sync.rows[0] as { reserve0: string; reserve1: string } | undefined;
        const sqrt = pair ? v2SqrtPriceX96(BigInt(pair.reserve0), BigInt(pair.reserve1)) : null;
        if (sqrt) poolRaw = { ...envio, sqrtPriceX96: sqrt.toString() };
      }
      const poolResult = (stream === 'v3-pool-swap' || stream === 'v2-pool-swap' || stream === 'v1-swap' || stream === 'v4-swap')
        && (stream !== 'v2-pool-swap' || poolRaw.sqrtPriceX96 !== undefined)
        ? await applyLivePoolEntries(appDb, options.chainId, [{ stream: stream === 'v3-pool-swap' ? 'v1-swap' : stream, raw: poolRaw }])
        : [];
      if ((launchResult?.applied ?? 0) > 0 || poolResult.some((outcome) => outcome.inserted)) report.replaced += 1;
    }
  }
  return report;
}
