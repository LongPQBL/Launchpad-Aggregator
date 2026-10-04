import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { resolveSyncTablesFromEnv, runAllSyncsOnce } from '../envioSync/syncAll.js';
import { enrichMetadataSafely, resolveMetadataBatchLimit, startMetadataEnrichmentLoop } from '../launchpads/pons/metadataEnrichment.js';
import { enrichPricesOnce, maintainRollingWindows, startPriceEnrichmentLoop } from '../market/quotePricing/priceEnrichment.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';

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
const metadataClient = syncTarget === 'real'
  ? createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com') : null;
const metadataBatchLimit = metadataClient ? resolveMetadataBatchLimit(process.env.ENVIO_METADATA_BATCH_LIMIT) : 10;

let stopping = false;
const metadataLoop = metadataClient
  ? startMetadataEnrichmentLoop(() => enrichMetadataSafely(db, metadataClient, new Date(), (event) => {
    if (event.kind === 'enrichment_error' || (event.claimed ?? 0) > 0) console.log('Envio metadata enrichment:', event);
  }, metadataBatchLimit)) : null;
const priceLoop = metadataClient
  ? startPriceEnrichmentLoop(() => maintainRollingWindows(pool, 4663, new Date())
    .catch((error) => console.error('Rolling-window maintenance failed, will retry next tick:', error))
    .then(() => enrichPricesOnce(pool, metadataClient, new Date(), quoteFeedRegistry.resolve))
    .then((report) => { if (report.claimed > 0) console.log('Price enrichment:', report); })
    .catch((error) => console.error('Price enrichment cycle failed, will retry next tick:', error))) : null;
let metadataStop: Promise<void> | null = null;
let priceStop: Promise<void> | null = null;
const stop = () => {
  stopping = true;
  metadataStop ??= metadataLoop?.stop() ?? Promise.resolve();
  priceStop ??= priceLoop?.stop() ?? Promise.resolve();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

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

await (metadataStop ?? metadataLoop?.stop());
await (priceStop ?? priceLoop?.stop());
await pool.end();
await envioPool.end();
console.log('Envio staging sync loop stopped.');
