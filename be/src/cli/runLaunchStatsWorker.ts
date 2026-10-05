import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { refreshLaunchStatsOnce } from '../api/launchStatsWorker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const batchLimit = Number(process.env.LAUNCH_STATS_BATCH_LIMIT ?? 25);
const tickMs = Number(process.env.LAUNCH_STATS_TICK_MS ?? 30_000);
const concurrency = Number(process.env.LAUNCH_STATS_CONCURRENCY ?? 1);
const pool = new Pool({ connectionString: databaseUrl, max: concurrency + 1 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const count = await refreshLaunchStatsOnce(pool, client, batchLimit, new Date(), concurrency);
      console.log(new Date().toISOString(), 'refreshed launch stats', count);
    } catch (error) {
      console.error('Launch stats refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
} finally {
  await pool.end();
}
