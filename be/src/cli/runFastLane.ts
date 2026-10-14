import { createDatabase } from '../db/client.js';
import { getChainConfig, rpcUrlFor } from '../chains/registry.js';
import { createViemChainSource } from '../fastLane/chainSource.js';
import { createFastLane } from '../fastLane/runner.js';
import { robinhood } from '../chains/robinhood.js';
import { redactError, redactUrls } from '../fastLane/redact.js';

// The WebSocket fast lane (docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md). Off unless FAST_LANE_ENABLED=true.
if (process.env.FAST_LANE_ENABLED !== 'true') {
  console.log('Fast lane is off (set FAST_LANE_ENABLED=true to run it).');
  process.exit(0);
}
function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? redactUrls(value) : value]));
}
let pool: ReturnType<typeof createDatabase>['pool'];
let lane: ReturnType<typeof createFastLane>;
let report: ReturnType<typeof setInterval>;
try {
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const wsUrl = process.env.RH_WS_RPC_URL;
if (!wsUrl) throw new Error('RH_WS_RPC_URL is required');
const chain = getChainConfig(robinhood.id)!;
const database = createDatabase(databaseUrl);
pool = database.pool;
const source = createViemChainSource(robinhood, { http: rpcUrlFor(chain, process.env), ws: wsUrl });
lane = createFastLane({ source, db: database.db, pool }, {
  chainId: chain.id,
  maxGapBlocks: process.env.FAST_LANE_MAX_GAP_BLOCKS ? BigInt(process.env.FAST_LANE_MAX_GAP_BLOCKS) : undefined,
  log: (message, fields) => console.log(new Date().toISOString(), redactUrls(message), fields ? redactFields(fields) : ''),
});
await lane.start();
console.log(new Date().toISOString(), `fast lane running for chain ${chain.id}`);
report = setInterval(() => console.log(new Date().toISOString(), 'fast lane stats', lane.stats()), 30_000);
} catch (error) {
  console.error(`fast lane failed to start: ${redactError(error)}`);
  process.exit(1);
}
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(report);
  try {
    await lane.stop();
    await pool.end();
  } catch (error) {
    console.error(`fast lane shutdown failed: ${redactError(error)}`);
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
