import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { resolveSyncTablesFromEnv, runAllSyncsOnce, runIncrementalCycle, runRepairCycle,
  runPoolCatalogCycle, runPoolCatalogRepairCycle, runAdditionalPoolCatalogCycle,
  runAdditionalPoolCatalogRepairCycle, additionalPoolRawTablesReady } from '../envioSync/syncAll.js';
import { enrichMetadataSafely, resolveMetadataBatchLimit, startMetadataEnrichmentLoop } from '../launchpads/pons/metadataEnrichment.js';
import { enrichPricesOnce, maintainRollingWindows, startPriceEnrichmentLoop } from '../market/quotePricing/priceEnrichment.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required (points at the self-hosted Envio Postgres from envio/docker-compose.yaml)');
const intervalMs = Number(process.env.ENVIO_SYNC_LOOP_INTERVAL_MS ?? 900_000);
const syncTarget = (process.env.ENVIO_SYNC_TARGET ?? 'staging') as 'staging' | 'real';
const additionalPoolSourcesAllowed = process.env.ENABLE_ADDITIONAL_POOL_SOURCES !== 'false';
if (syncTarget !== 'staging' && syncTarget !== 'real') throw new Error('ENVIO_SYNC_TARGET must be "staging" or "real"');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const tables = resolveSyncTablesFromEnv();
const metadataClient = syncTarget === 'real'
  ? createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com') : null;
const metadataBatchLimit = metadataClient ? resolveMetadataBatchLimit(process.env.ENVIO_METADATA_BATCH_LIMIT) : 10;

let stopping = false;
const metadataLoop = metadataClient
  ? startMetadataEnrichmentLoop(() => enrichMetadataSafely(db, envioPool, metadataClient, new Date(), (event) => {
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

// A jittered backoff after a failed cycle, instead of always retrying at the fixed tail interval —
// a stuck DB or Envio outage must not turn into a tight failing retry loop.
function backoffWithJitter(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return base + Math.floor(Math.random() * base * 0.5);
}

if (syncTarget === 'staging') {
  console.log(`Starting Envio sync loop (target: staging, interval ${intervalMs}ms). Ctrl+C or SIGTERM stops it after the current cycle.`);
  while (!stopping) {
    const startedAt = new Date().toISOString();
    try {
      const { v1Result, v2Result, v4Result } = await runAllSyncsOnce(envioPool, db, tables, syncTarget);
      console.log(`[${startedAt}] Synced V1-legacy from Envio into staging:`, v1Result);
      console.log(`[${startedAt}] Synced V2 from Envio into staging:`, v2Result);
      console.log(`[${startedAt}] Synced V4 from Envio into staging:`, v4Result);
    } catch (error) {
      // A single bad cycle (e.g. a transient DB disconnect, or Envio not having reached a block yet)
      // must not kill the loop — log it and retry at the next interval, matching the main indexer's
      // own per-cycle try/catch resilience (be/src/cli/runFactoryIndexer.ts).
      console.error(`[${startedAt}] Envio staging sync cycle failed, will retry next interval:`, error);
    }
    if (stopping) break;
    await interruptibleSleep(intervalMs);
  }
} else {
  // The 'real' target replaces the old full-table reread loop with bounded incremental tail+history
  // passes on a short interruptible cadence (spec target: 1s). `runAllSyncsOnce` above remains the
  // offline full-table reconciliation command — it is not called from this live loop for 'real'.
  // No RPC client is needed for ingestion itself (metadataClient still drives the separate extended/
  // core-metadata enrichment loops started above).
  const tailIntervalMs = Number(process.env.ENVIO_TAIL_PASS_INTERVAL_MS ?? 1000);
  const limit = Number(process.env.ENVIO_INCREMENTAL_PAGE_LIMIT ?? 500);
  // Reorg repair compares a whole ~500-block window per stream — materially heavier than one bounded
  // tail page, so it runs far less often than every tick, not on every pass.
  const repairEveryTicks = Number(process.env.ENVIO_REPAIR_EVERY_TICKS ?? 30);
  console.log(`Starting Envio incremental sync loop (target: real, tail interval ${tailIntervalMs}ms, page limit ${limit}, `
    + `repair every ${repairEveryTicks} ticks). Ctrl+C or SIGTERM stops it after the current cycle.`);
  let failureStreak = 0;
  let tick = 0;
  let additionalPoolSourcesReady = false;
  while (!stopping) {
    const startedAt = new Date().toISOString();
    try {
      const { tail, history } = await runIncrementalCycle(envioPool, db, 4663, { limit, progressTable: tables.v1.progressTable });
      if (additionalPoolSourcesAllowed && tick % 30 === 0) {
        additionalPoolSourcesReady = await additionalPoolRawTablesReady(envioPool);
      }
      const poolTables = { initialize: tables.v4.rawV4InitializeTable, swap: tables.v4.rawV4SwapTable };
      const poolPages = await runPoolCatalogCycle(envioPool, db, 4663, { limit, progressTable: tables.v1.progressTable, tables: poolTables });
      const additionalPoolPages = additionalPoolSourcesReady
        ? await runAdditionalPoolCatalogCycle(envioPool, db, 4663, { limit, progressTable: tables.v1.progressTable }) : null;
      failureStreak = 0;
      console.log(`[${startedAt}] Envio tail pass:`, tail.results);
      console.log(`[${startedAt}] Envio history pass:`, history.results);
      console.log(`[${startedAt}] V4 pool catalog pages:`, poolPages);
      if (additionalPoolPages) console.log(`[${startedAt}] V3/V2 pool catalog pages (parity-gated):`, additionalPoolPages);
      tick += 1;
      if (tick % repairEveryTicks === 0) {
        const repairReport = await runRepairCycle(envioPool, db, 4663, { progressTable: tables.v1.progressTable });
        const poolRepair = await runPoolCatalogRepairCycle(envioPool, db, 4663,
          { progressTable: tables.v1.progressTable, tables: poolTables });
        const additionalPoolRepair = additionalPoolSourcesReady
          ? await runAdditionalPoolCatalogRepairCycle(envioPool, db, 4663,
            { progressTable: tables.v1.progressTable }) : null;
        console.log(`[${startedAt}] Envio reorg repair: ${repairReport.changedLaunchKeys.length} launch(es) affected`);
        console.log(`[${startedAt}] V4 pool catalog repair:`, poolRepair);
        if (additionalPoolRepair) console.log(`[${startedAt}] V3/V2 pool catalog repair:`, additionalPoolRepair);
      }
    } catch (error) {
      failureStreak += 1;
      console.error(`[${startedAt}] Envio incremental sync cycle failed (streak ${failureStreak}), backing off:`, error);
      if (stopping) break;
      await interruptibleSleep(backoffWithJitter(failureStreak));
      continue;
    }
    if (stopping) break;
    await interruptibleSleep(tailIntervalMs);
  }
}

await (metadataStop ?? metadataLoop?.stop());
await (priceStop ?? priceLoop?.stop());
await pool.end();
await envioPool.end();
console.log('Envio staging sync loop stopped.');
