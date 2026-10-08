import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { parseSnapshotConfig, runSnapshotCycle } from '../pools/tvlCapture.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const config = parseSnapshotConfig(process.env);
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  while (!stopping) {
    try {
      const result = await runSnapshotCycle(pool, client, config, Math.floor(Date.now() / 1000));
      console.log(`Pool TVL snapshots: captured=${result.captured} skipped=${result.skipped} pruned=${result.pruned}`);
    } catch (error) {
      console.error('Pool TVL snapshot cycle failed; retrying next interval:', error);
    }
    for (let waited = 0; waited < config.intervalSeconds && !stopping; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} finally { await pool.end(); }
