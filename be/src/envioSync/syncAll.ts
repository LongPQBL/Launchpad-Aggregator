import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { syncV1LegacyOnce, syncV1LegacyToReal, DEFAULT_ENVIO_TABLES, type EnvioTableNames } from './runSync.js';
import { syncV2Once, syncV2ToReal, DEFAULT_ENVIO_V2_TABLES, type EnvioV2TableNames } from './runSyncV2.js';
import { syncV4Once, syncV4ToReal, DEFAULT_ENVIO_V4_TABLES, type EnvioV4TableNames } from './runSyncV4.js';
import { readEnvioProgress, recordEnvioChainProgress } from './envioDb.js';
import { runTailPass, runHistoryPass, retryUnresolvedEvents, syncSourceCoverage, type SyncReport } from './incrementalSync.js';
import { repairEnvioWindow, recordRepairOutcome, type RepairReport } from './incrementalRepair.js';
import { STREAMS, detectEnvioRollback, type Stream } from './incrementalCursor.js';
import { repairPoolWindow, syncV4PoolPage, updatePoolCoverage, type PoolRepairReport, type PoolSyncPageResult,
  type PoolStream } from '../pools/syncV4Pools.js';

export interface AllSyncTables {
  v1: EnvioTableNames;
  v2: EnvioV2TableNames;
  v4: EnvioV4TableNames;
}

export type SyncTarget = 'staging' | 'real';

export function resolveSyncTablesFromEnv(): AllSyncTables {
  const progressTable = process.env.ENVIO_PROGRESS_TABLE;
  return {
    v1: {
      rawLaunchTable: process.env.ENVIO_RAW_LAUNCH_TABLE ?? DEFAULT_ENVIO_TABLES.rawLaunchTable,
      rawSwapTable: process.env.ENVIO_RAW_SWAP_TABLE ?? DEFAULT_ENVIO_TABLES.rawSwapTable,
      ...(progressTable ? { progressTable } : {}),
    },
    v2: {
      rawLaunchV2Table: process.env.ENVIO_RAW_LAUNCH_V2_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLaunchV2Table,
      rawCurveTradeTable: process.env.ENVIO_RAW_CURVE_TRADE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveTradeTable,
      rawCurveBuybackTable: process.env.ENVIO_RAW_CURVE_BUYBACK_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveBuybackTable,
      rawLifecycleTable: process.env.ENVIO_RAW_LIFECYCLE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLifecycleTable,
      ...(progressTable ? { progressTable } : {}),
    },
    v4: {
      rawV4InitializeTable: process.env.ENVIO_RAW_V4_INITIALIZE_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4InitializeTable,
      rawV4SwapTable: process.env.ENVIO_RAW_V4_SWAP_TABLE ?? DEFAULT_ENVIO_V4_TABLES.rawV4SwapTable,
      ...(progressTable ? { progressTable } : {}),
    },
  };
}

export async function runAllSyncsOnce(envioPool: Pool, appDb: Database, tables: AllSyncTables, target: SyncTarget = 'staging') {
  const v1Result = target === 'real' ? await syncV1LegacyToReal(envioPool, appDb, tables.v1) : await syncV1LegacyOnce(envioPool, appDb, tables.v1);
  const v2Result = target === 'real' ? await syncV2ToReal(envioPool, appDb, tables.v2) : await syncV2Once(envioPool, appDb, tables.v2);
  const v4Result = target === 'real' ? await syncV4ToReal(envioPool, appDb, tables.v4) : await syncV4Once(envioPool, appDb, tables.v4);
  // Only mirrored into envio_chain_progress for the real-table target — the API's safeHead()/
  // coverage() only need to see Envio's head once Envio is (or may become) the actual write path;
  // staging-target runs are a verification tool, not something coverage should react to (final
  // review, Important 3).
  if (target === 'real') {
    const { headBlock } = await readEnvioProgress(envioPool, tables.v1.progressTable);
    await recordEnvioChainProgress(appDb, 4663, headBlock);
  }
  return { v1Result, v2Result, v4Result };
}

export interface IncrementalSyncDeps {
  tables?: Partial<Record<Stream, string>>;
  limit?: number;
  progressTable?: string;
}

/**
 * One bounded tail pass (fresh activity) plus one bounded history pass (backfill), replacing
 * `runAllSyncsOnce`'s full-table reread as the live loop's unit of work — see
 * docs/superpowers/specs/2026-10-05-envio-near-realtime-sync-design.md. `runAllSyncsOnce` remains for
 * offline reconciliation; this is additive, not a replacement of that function. No RPC client is
 * needed here — a new launch's name/symbol/decimals are deferred to the core-metadata enrichment job.
 */
export async function runIncrementalCycle(
  envioPool: Pool, appDb: Database, chainId: number, deps: IncrementalSyncDeps = {},
): Promise<{ tail: SyncReport; history: SyncReport }> {
  const { processedBlock, headBlock } = await readEnvioProgress(envioPool, deps.progressTable);
  const limit = deps.limit ?? 500;
  // If Envio's own processed block has rolled back behind a cursor, the normal read range below
  // becomes empty while the cursor's position is still past the new fence — advanceSyncCursor's
  // guard would throw on every cycle until Envio happens to pass the old position again, and the
  // periodic repair schedule wouldn't get a chance to run while every tick keeps failing. Repair
  // immediately instead of waiting for it (final review, Important 8).
  if (await detectEnvioRollback(appDb, chainId, processedBlock)) {
    await repairEnvioWindow(envioPool, appDb, { chainId, fence: processedBlock, depth: 500n, tables: deps.tables });
  }
  const passInput = { chainId, envioPool, appDb, fence: processedBlock, limit, tables: deps.tables };
  const tail = await runTailPass(passInput);
  const history = await runHistoryPass(passInput);
  // Without this, a row queued because its dependency hadn't arrived yet is never revisited in
  // production — only the integration test ever called retryUnresolvedEvents directly (final
  // review, Critical 1). Run it for every stream each cycle; a stream with nothing due is a cheap
  // no-op claim.
  for (const stream of STREAMS) {
    await retryUnresolvedEvents(envioPool, appDb, { chainId, stream, limit, tables: deps.tables });
  }
  // Without this, the API's per-launch coverage/backfilling status and officialVolume24h stay
  // frozen at whatever a source's row was last set to (or its insert-time default) forever once the
  // incremental path is the only writer — nothing else ever advances it (final review, Critical 3).
  await syncSourceCoverage(appDb, chainId, headBlock);
  await recordEnvioChainProgress(appDb, chainId, headBlock);
  return { tail, history };
}

export interface RepairCycleDeps {
  tables?: Partial<Record<Stream, string>>;
  depth?: bigint;
  progressTable?: string;
}

// All-V4 discovery keeps its own cursor and trade tables so it never changes the official Pons feed.
export async function runPoolCatalogCycle(envioPool: Pool, appDb: Database, chainId: number,
  deps: { limit?: number; progressTable?: string; tables?: Partial<Record<PoolStream, string>> } = {},
): Promise<PoolSyncPageResult[]> {
  const { processedBlock } = await readEnvioProgress(envioPool, deps.progressTable);
  const results: PoolSyncPageResult[] = [];
  for (const lane of ['tail', 'history'] as const) {
    for (const stream of ['initialize', 'swap'] as const) {
      results.push(await syncV4PoolPage(envioPool, appDb, { chainId, lane, stream,
        fence: processedBlock, limit: deps.limit ?? 500, tables: deps.tables }));
    }
  }
  await updatePoolCoverage(appDb, chainId, processedBlock);
  return results;
}

export async function runPoolCatalogRepairCycle(envioPool: Pool, appDb: Database, chainId: number,
  deps: { depth?: bigint; progressTable?: string; tables?: Partial<Record<PoolStream, string>> } = {},
): Promise<PoolRepairReport> {
  const { processedBlock } = await readEnvioProgress(envioPool, deps.progressTable);
  return repairPoolWindow(envioPool, appDb, { chainId, fence: processedBlock,
    depth: deps.depth ?? 500n, tables: deps.tables });
}

/**
 * Bounded reorg repair over the last `depth` blocks (default 500 — the standard reorg safety margin).
 * Records its own success/failure into envio_repair_state so a silently-failing repair worker stays
 * observable through the coverage API, then rethrows — the caller's own retry/backoff is unchanged.
 */
export async function runRepairCycle(envioPool: Pool, appDb: Database, chainId: number, deps: RepairCycleDeps = {}): Promise<RepairReport> {
  try {
    const { processedBlock } = await readEnvioProgress(envioPool, deps.progressTable);
    const report = await repairEnvioWindow(envioPool, appDb, { chainId, fence: processedBlock, depth: deps.depth ?? 500n, tables: deps.tables });
    await recordRepairOutcome(appDb, chainId, new Date(), null);
    return report;
  } catch (error) {
    await recordRepairOutcome(appDb, chainId, new Date(), error).catch(() => { /* best-effort; the original error still propagates */ });
    throw error;
  }
}
