import { readApiConfig } from '../api/config.js';
import { ApiEventBus } from '../api/events.js';
import { listenForDatabaseEvents } from '../api/pgEvents.js';
import { createApiServer } from '../api/server.js';
import { createApiStore } from '../api/store.js';
import { startLiveLaunchStats } from '../api/liveLaunchStats.js';
import { createPoolApiStore } from '../api/poolStore.js';
import { createSearchStore } from '../api/searchStore.js';
import { createWalletStore } from '../api/walletStore.js';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';

const config = readApiConfig(process.env);
const { pool } = createDatabase(config.databaseUrl);
const events = new ApiEventBus();
const stopEvents = await listenForDatabaseEvents(pool, events);
const rpcClient = createRobinhoodPublicClient(config.rpcUrl);
const data = createApiStore(pool, rpcClient);
const pools = createPoolApiStore(pool, rpcClient, undefined, events);
const stopLiveStats = startLiveLaunchStats(pool, rpcClient, events);
const app = await createApiServer({ feOrigin: config.feOrigin, data, pools, search: createSearchStore(pool, rpcClient), wallets: createWalletStore(pool), events });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`API listening on http://${config.host}:${config.port}`);
  // The first request after a start pays for every cold RPC read (token decimals, names, block times, supply); asking for the first page of
  // the two main lists now moves that cost off the first visitor. Failures are only logged: this is an optimization, not a dependency.
  void Promise.allSettled([data.listLaunches({ limit: 50 } as never), pools.listPools({ limit: 50 })]).then((results) => {
    const failed = results.filter((result) => result.status === 'rejected').length;
    app.log.info(failed === 0 ? 'Warmed the launch and pool lists' : `Warm-up finished with ${failed} failure(s)`);
  });
} catch (error) {
  stopLiveStats();
  await stopEvents();
  await pool.end();
  throw error;
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopLiveStats();
  await app.close();
  await stopEvents();
  await pool.end();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
