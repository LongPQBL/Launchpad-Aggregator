import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { resolveSyncTablesFromEnv, runAllSyncsOnce } from '../envioSync/syncAll.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');
const intervalMs = Number(process.env.ENVIO_SYNC_LOOP_INTERVAL_MS ?? 900_000);
const syncTarget = (process.env.ENVIO_SYNC_TARGET ?? 'staging') as 'staging' | 'real';
if (syncTarget !== 'staging' && syncTarget !== 'real') throw new Error('ENVIO_SYNC_TARGET must be "staging" or "real"');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const tables = resolveSyncTablesFromEnv();

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

// Checked in 1s steps rather than one setTimeout(intervalMs) so SIGINT/SIGTERM during the wait is
// honored within ~1s instead of up to the full interval.
async function interruptibleSleep(ms: number): Promise<void> {
  let waited = 0;
  while (waited < ms && !stopping) {
    const step = Math.min(1000, ms - waited);
    await new Promise((resolve) => setTimeout(resolve, step));
    waited += step;
  }
}

console.log(`Starting Envio sync loop (target: ${syncTarget}, interval ${intervalMs}ms). Ctrl+C or SIGTERM stops it after the current cycle.`);
while (!stopping) {
  const startedAt = new Date().toISOString();
  try {
    const { v1Result, v2Result, v4Result } = await runAllSyncsOnce(envioPool, db, tables, syncTarget);
    console.log(`[${startedAt}] Synced V1-legacy from Envio into ${syncTarget}:`, v1Result);
    console.log(`[${startedAt}] Synced V2 from Envio into ${syncTarget}:`, v2Result);
    console.log(`[${startedAt}] Synced V4 from Envio into ${syncTarget}:`, v4Result);
  } catch (error) {
    // A single bad cycle (e.g. a transient DB disconnect, or Envio not having reached a block yet)
    // must not kill the loop — log it and retry at the next interval, matching the main indexer's
    // own per-cycle try/catch resilience (be/src/cli/runFactoryIndexer.ts).
    console.error(`[${startedAt}] Envio staging sync cycle failed, will retry next interval:`, error);
  }
  if (stopping) break;
  await interruptibleSleep(intervalMs);
}

await pool.end();
await envioPool.end();
console.log('Envio staging sync loop stopped.');
