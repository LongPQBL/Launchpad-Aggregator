import { Pool } from 'pg';
import { createRobinhoodPublicClient, robinhood } from '../chains/robinhood.js';
import { enrichPricesOnce, maintainRollingWindows } from '../market/quotePricing/priceEnrichment.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';

// Keeps the USD quote feeds resolved and their oracle rounds up to date: resolves pending feed-resolution jobs, backfills the rounds of the
// rolling window and of any enqueued range (see `npm run -w be prices:backfill-history`), one pass every PRICE_WORKER_INTERVAL_SECONDS (default 30).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const intervalSeconds = Number(process.env.PRICE_WORKER_INTERVAL_SECONDS ?? 30);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) throw new Error('PRICE_WORKER_INTERVAL_SECONDS must be a number of at least 5');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    await maintainRollingWindows(pool, robinhood.id, new Date()).catch((error) => console.error('rolling windows failed:', error));
    const report = await enrichPricesOnce(pool, client, robinhood.id, new Date(), quoteFeedRegistry.resolve).catch((error) => {
      console.error('price enrichment failed:', error);
      return null;
    });
    console.log(new Date().toISOString(), report);
    for (let waited = 0; waited < intervalSeconds && !stopping; waited += 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally { await pool.end(); }
