import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { resolveSyncTablesFromEnv, runAllSyncsOnce } from '../envioSync/syncAll.js';
import { enrichMetadataSafely } from '../launchpads/pons/metadataEnrichment.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');
const syncTarget = (process.env.ENVIO_SYNC_TARGET ?? 'staging') as 'staging' | 'real';
if (syncTarget !== 'staging' && syncTarget !== 'real') throw new Error('ENVIO_SYNC_TARGET must be "staging" or "real"');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const tables = resolveSyncTablesFromEnv();

try {
  const { v1Result, v2Result, v4Result } = await runAllSyncsOnce(envioPool, db, tables, syncTarget);
  console.log(`Synced V1-legacy from Envio into ${syncTarget}:`, v1Result);
  console.log(`Synced V2 from Envio into ${syncTarget}:`, v2Result);
  console.log(`Synced V4 from Envio into ${syncTarget}:`, v4Result);
  if (syncTarget === 'real') {
    const metadataClient = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
    await enrichMetadataSafely(db, metadataClient, new Date(), (event) => console.log('Envio metadata enrichment:', event));
  }
} finally {
  await pool.end();
  await envioPool.end();
}
