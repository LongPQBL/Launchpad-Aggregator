import { createDatabase } from '../db/client.js';
import { getChainConfig, rpcUrlFor } from '../chains/registry.js';
import { robinhood } from '../chains/robinhood.js';
import { createViemChainSource } from '../fastLane/chainSource.js';
import { classifyLog } from '../fastLane/decode.js';
import { redactError } from '../fastLane/redact.js';
import { isWatched, loadWatchSet } from '../fastLane/watchSet.js';

// Counts, for `seconds`, how many logs of each trade event the chain emits and how many belong to a known launch venue. Read-only.
const seconds = Number(process.argv[2] ?? 60);
const databaseUrl = process.env.DATABASE_URL;
const wsUrl = process.env.RH_WS_RPC_URL;
if (!databaseUrl || !wsUrl) throw new Error('DATABASE_URL and RH_WS_RPC_URL are required');
const { pool } = createDatabase(databaseUrl);
let exitCode = 0;
try {
  const chain = getChainConfig(robinhood.id)!;
  const watch = await loadWatchSet(pool, chain.id);
  const source = createViemChainSource(robinhood, { http: rpcUrlFor(chain, process.env), ws: wsUrl });
  const totals: Record<string, { all: number; watched: number }> = {};
  const stop = source.subscribeLogs((logs) => {
    for (const log of logs) {
      const cls = classifyLog(log);
      if (!cls) continue;
      const entry = (totals[cls.event] ??= { all: 0, watched: 0 });
      entry.all += 1;
      if (isWatched(watch, cls)) entry.watched += 1;
    }
  }, (error) => console.error('subscription error', redactError(error)));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  stop();
  console.log(JSON.stringify({ seconds, venues: { curve: watch.curve.size, v3_pool: watch.v3_pool.size, v4_pool: watch.v4_pool.size },
    perSecond: Object.fromEntries(Object.entries(totals).map(([event, count]) => [event, { all: +(count.all / seconds).toFixed(2), watched: +(count.watched / seconds).toFixed(2) }])) }, null, 1));
} catch (error) {
  console.error(redactError(error));
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
