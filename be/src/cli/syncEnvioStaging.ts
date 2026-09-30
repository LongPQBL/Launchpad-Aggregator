import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { syncV1LegacyOnce, DEFAULT_ENVIO_TABLES } from '../envioSync/runSync.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });

const tables = {
  rawLaunchTable: process.env.ENVIO_RAW_LAUNCH_TABLE ?? DEFAULT_ENVIO_TABLES.rawLaunchTable,
  rawSwapTable: process.env.ENVIO_RAW_SWAP_TABLE ?? DEFAULT_ENVIO_TABLES.rawSwapTable,
};

try {
  const result = await syncV1LegacyOnce(envioPool, db, tables);
  console.log('Synced from Envio into staging:', result);
} finally {
  await pool.end();
  await envioPool.end();
}
