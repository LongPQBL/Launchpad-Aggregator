import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { resolveSyncTablesFromEnv, runAllSyncsOnce } from '../envioSync/syncAll.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const tables = resolveSyncTablesFromEnv();

try {
  const { v1Result, v2Result, v4Result } = await runAllSyncsOnce(envioPool, db, tables);
  console.log('Synced V1-legacy from Envio into staging:', v1Result);
  console.log('Synced V2 from Envio into staging:', v2Result);
  console.log('Synced V4 from Envio into staging:', v4Result);
} finally {
  await pool.end();
  await envioPool.end();
}
