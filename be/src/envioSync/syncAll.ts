import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { syncV1LegacyOnce, syncV1LegacyToReal, DEFAULT_ENVIO_TABLES, type EnvioTableNames } from './runSync.js';
import { syncV2Once, syncV2ToReal, DEFAULT_ENVIO_V2_TABLES, type EnvioV2TableNames } from './runSyncV2.js';
import { syncV4Once, syncV4ToReal, DEFAULT_ENVIO_V4_TABLES, type EnvioV4TableNames } from './runSyncV4.js';
import { readEnvioProgress, recordEnvioChainProgress } from './envioDb.js';
import { runTailPass, runHistoryPass, type SyncReport } from './incrementalSync.js';
import { repairEnvioWindow, type RepairReport } from './incrementalRepair.js';
import type { Stream } from './incrementalCursor.js';

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
  const passInput = { chainId, envioPool, appDb, fence: processedBlock, limit, tables: deps.tables };
  const tail = await runTailPass(passInput);
  const history = await runHistoryPass(passInput);
  await recordEnvioChainProgress(appDb, chainId, headBlock);
  return { tail, history };
}

export interface RepairCycleDeps {
  tables?: Partial<Record<Stream, string>>;
  depth?: bigint;
  progressTable?: string;
}

/** Bounded reorg repair over the last `depth` blocks (default 500 — the standard reorg safety margin). */
export async function runRepairCycle(envioPool: Pool, appDb: Database, chainId: number, deps: RepairCycleDeps = {}): Promise<RepairReport> {
  const { processedBlock } = await readEnvioProgress(envioPool, deps.progressTable);
  return repairEnvioWindow(envioPool, appDb, { chainId, fence: processedBlock, depth: deps.depth ?? 500n, tables: deps.tables });
}
