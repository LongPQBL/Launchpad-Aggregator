import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { syncV1LegacyOnce, syncV1LegacyToReal, DEFAULT_ENVIO_TABLES, type EnvioTableNames } from './runSync.js';
import { syncV2Once, syncV2ToReal, DEFAULT_ENVIO_V2_TABLES, type EnvioV2TableNames } from './runSyncV2.js';
import { syncV4Once, syncV4ToReal, DEFAULT_ENVIO_V4_TABLES, type EnvioV4TableNames } from './runSyncV4.js';

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
  return { v1Result, v2Result, v4Result };
}
