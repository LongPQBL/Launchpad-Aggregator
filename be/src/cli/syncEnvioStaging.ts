import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { syncV1LegacyOnce, DEFAULT_ENVIO_TABLES } from '../envioSync/runSync.js';
import { syncV2Once, DEFAULT_ENVIO_V2_TABLES } from '../envioSync/runSyncV2.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });

const v1Tables = {
  rawLaunchTable: process.env.ENVIO_RAW_LAUNCH_TABLE ?? DEFAULT_ENVIO_TABLES.rawLaunchTable,
  rawSwapTable: process.env.ENVIO_RAW_SWAP_TABLE ?? DEFAULT_ENVIO_TABLES.rawSwapTable,
};
const v2Tables = {
  rawLaunchV2Table: process.env.ENVIO_RAW_LAUNCH_V2_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLaunchV2Table,
  rawCurveTradeTable: process.env.ENVIO_RAW_CURVE_TRADE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveTradeTable,
  rawCurveBuybackTable: process.env.ENVIO_RAW_CURVE_BUYBACK_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawCurveBuybackTable,
  rawLifecycleTable: process.env.ENVIO_RAW_LIFECYCLE_TABLE ?? DEFAULT_ENVIO_V2_TABLES.rawLifecycleTable,
};

try {
  const v1Result = await syncV1LegacyOnce(envioPool, db, v1Tables);
  console.log('Synced V1-legacy from Envio into staging:', v1Result);
  const v2Result = await syncV2Once(envioPool, db, v2Tables);
  console.log('Synced V2 from Envio into staging:', v2Result);
} finally {
  await pool.end();
  await envioPool.end();
}
