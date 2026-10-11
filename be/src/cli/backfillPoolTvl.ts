import { Pool } from 'pg';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { backfillPoolTvl, type BackfillClient } from '../pools/tvlBackfill.js';

// Fills past TVL buckets from archive state. Resumable: re-running only fills what is missing. Needs an archive-capable RH_HTTP_RPC_URL.
//   npm run -w be pools:tvl-backfill -- --days 90 --concurrency 4
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const argument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com') as unknown as BackfillClient;
try {
  const started = Date.now();
  const result = await backfillPoolTvl(pool, client, {
    days: argument('days', 90), poolConcurrency: argument('concurrency', 4), nowSeconds: Math.floor(Date.now() / 1000),
    log: (message) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`),
  });
  console.log('TVL backfill done:', result);
} finally { await pool.end(); }
