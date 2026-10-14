import { Pool } from 'pg';
import { listenForDatabaseEvents } from '../api/pgEvents.js';
import { ApiEventBus } from '../api/events.js';
import { startLiveLaunchStats } from '../api/liveLaunchStats.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';

// Recomputes a launch's stored list figures as soon as a trade for it is announced, and announces `launch.changed` through Postgres so
// every API instance (and so every browser) hears it once. Run it instead of the API's built-in copy (LIVE_LAUNCH_STATS_IN_API=false).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const concurrency = Number(process.env.LIVE_LAUNCH_STATS_CONCURRENCY ?? 2);
const pool = new Pool({ connectionString: databaseUrl, max: concurrency + 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
const bus = new ApiEventBus();
const stopListening = await listenForDatabaseEvents(pool, bus);
const stop = startLiveLaunchStats(pool, client, bus, {
  concurrency,
  announce: (event) => {
    void pool.query('SELECT pg_notify($1, $2)', ['launchpad_events', JSON.stringify({ type: event.type, chainId: event.chainId, tokenAddress: event.tokenAddress })])
      .catch((error) => console.error('Could not announce launch.changed:', error));
  },
});
console.log(new Date().toISOString(), 'live launch stats worker listening');

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  stop();
  await stopListening();
  await pool.end();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
