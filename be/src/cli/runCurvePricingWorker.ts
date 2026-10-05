import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { applyCurvePricingOnce } from '../market/curvePricing.js';

const databaseUrl = process.env.DATABASE_URL;
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!envioDatabaseUrl) throw new Error('ENVIO_DATABASE_URL is required');
const batchLimit = Number(process.env.CURVE_PRICING_BATCH_LIMIT ?? 25);
const tickMs = Number(process.env.CURVE_PRICING_TICK_MS ?? 30_000);
const pool = new Pool({ connectionString: databaseUrl });
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const report = await applyCurvePricingOnce(pool, envioPool, client, batchLimit, new Date());
      console.log(new Date().toISOString(), 'priced curve trades', report);
    } catch (error) {
      console.error('Curve pricing pass failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
} finally {
  await pool.end();
  await envioPool.end();
}
