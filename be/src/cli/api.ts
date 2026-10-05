import { readApiConfig } from '../api/config.js';
import { ApiEventBus } from '../api/events.js';
import { listenForDatabaseEvents } from '../api/pgEvents.js';
import { createApiServer } from '../api/server.js';
import { createApiStore } from '../api/store.js';
import { createPoolApiStore } from '../api/poolStore.js';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';

const config = readApiConfig(process.env);
const { pool } = createDatabase(config.databaseUrl);
const events = new ApiEventBus();
const stopEvents = await listenForDatabaseEvents(pool, events);
const rpcClient = createRobinhoodPublicClient(config.rpcUrl);
const app = await createApiServer({ feOrigin: config.feOrigin, data: createApiStore(pool),
  pools: createPoolApiStore(pool, rpcClient), events });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`API listening on http://${config.host}:${config.port}`);
} catch (error) {
  await stopEvents();
  await pool.end();
  throw error;
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  await stopEvents();
  await pool.end();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
