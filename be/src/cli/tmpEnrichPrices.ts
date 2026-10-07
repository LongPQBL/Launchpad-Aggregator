import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { enrichPricesOnce, maintainRollingWindows } from '../market/quotePricing/priceEnrichment.js';
import { quoteFeedRegistry } from '../market/quoteFeedRegistry.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');

for (let round = 0; round < 200; round++) {
  await maintainRollingWindows(pool, 4663, new Date()).catch((error) => console.error('rolling windows failed:', error));
  const report = await enrichPricesOnce(pool, client, new Date(), quoteFeedRegistry.resolve).catch((error) => {
    console.error('price enrichment failed:', error);
    return null;
  });
  console.log(new Date().toISOString(), report);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
await pool.end();
