import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { refreshLaunchStatsOnce } from '../api/launchStatsWorker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const count = await refreshLaunchStatsOnce(pool, client, 25, new Date());
      console.log(new Date().toISOString(), 'refreshed launch stats', count);
    } catch (error) {
      console.error('Launch stats refresh failed; retrying:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
} finally {
  await pool.end();
}
