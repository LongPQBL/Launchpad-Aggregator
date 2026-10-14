import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { getChainConfig, rpcUrlFor } from '../chains/registry.js';
import { createViemChainSource } from '../fastLane/chainSource.js';
import { createFastLane } from '../fastLane/runner.js';
import { robinhood } from '../chains/robinhood.js';
import { installConsoleRedaction, installFatalErrorHandlers, redactError, redactUrls } from '../fastLane/redact.js';
import { reconcileLaneRows } from '../fastLane/reconcile.js';
import { socketWatchdogVerdict } from '../fastLane/watchdog.js';
import { readEnvioProgress } from '../envioSync/envioDb.js';
import { createGovernor, readEnvioLagBlocks } from '../fastLane/governor.js';

// The WebSocket fast lane (docs/superpowers/specs/2026-10-14-websocket-fast-lane-design.md).
// FAST_LANE_MODE: off (default) | on (always running) | auto (runs only while Envio's pipeline trails the chain head, see governor.ts).
// FAST_LANE_ENABLED=true is the older spelling of mode `on`.
const mode = process.env.FAST_LANE_MODE ?? (process.env.FAST_LANE_ENABLED === 'true' ? 'on' : 'off');
if (mode !== 'on' && mode !== 'auto') {
  console.log('Fast lane is off (set FAST_LANE_MODE=auto to run it only while Envio is behind, or FAST_LANE_MODE=on to always run it).');
  process.exit(0);
}
// Before anything can print an RPC URL: libraries (viem's socket reconnect) print errors on their own.
installConsoleRedaction(console);
installFatalErrorHandlers(process);

const RECONCILE_EVERY_MS = 60_000;
const WATCHDOG_EVERY_MS = 60_000;
const stamp = () => new Date().toISOString();
function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? redactUrls(value) : value]));
}
let pool: ReturnType<typeof createDatabase>['pool'];
let lane: ReturnType<typeof createFastLane>;
let envioPool: Pool | null = null;
let running = false;
const timers: ReturnType<typeof setInterval>[] = [];
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
    log: (message, fields) => console.log(stamp(), redactUrls(message), fields ? redactFields(fields) : ''),
  });
  const startLane = async () => { await lane.start(); running = true; console.log(stamp(), `fast lane running for chain ${chain.id}`); };
  const stopLane = async () => { running = false; await lane.stop(); console.log(stamp(), 'fast lane stopped'); };
  if (mode === 'on') await startLane();
  else console.log(stamp(), 'fast lane in auto mode: waiting for Envio to fall behind');
  timers.push(setInterval(() => { if (running) console.log(stamp(), 'fast lane stats', lane.stats()); }, 30_000));

  // auto: run the lane only while it gains something (Envio trails the head), with hysteresis so it does not flap.
  if (mode === 'auto') {
    const governor = createGovernor({
      onLagBlocks: process.env.FAST_LANE_AUTO_ON_LAG_BLOCKS ? Number(process.env.FAST_LANE_AUTO_ON_LAG_BLOCKS) : undefined,
      offLagBlocks: process.env.FAST_LANE_AUTO_OFF_LAG_BLOCKS ? Number(process.env.FAST_LANE_AUTO_OFF_LAG_BLOCKS) : undefined,
    });
    let sampling = false;
    timers.push(setInterval(() => {
      if (sampling) return;
      sampling = true;
      void (async () => {
        try {
          const lag = await readEnvioLagBlocks(pool, chain.id, await source.getBlockNumber());
          const change = governor.observe(lag);
          if (change === 'on') { console.log(stamp(), `Envio trails the head by ${lag ?? 'an unknown number of'} blocks: starting the fast lane`); await startLane(); }
          if (change === 'off') { console.log(stamp(), `Envio keeps up (${lag} blocks behind): stopping the fast lane`); await stopLane(); }
        } catch (error) {
          console.error(stamp(), `fast lane governor sample failed: ${redactError(error)}`);
        } finally {
          sampling = false;
        }
      })();
    }, Number(process.env.FAST_LANE_AUTO_SAMPLE_SECONDS ?? 10) * 1000));
  }

  // A dead subscription is silent, not an error: warn while it lasts, then exit so the supervisor restarts the process.
  timers.push(setInterval(() => {
    if (!running) return;
    const silent = lane.socketSilentForSeconds();
    const verdict = socketWatchdogVerdict(silent);
    if (verdict === 'warn') console.warn(stamp(), `fast lane: no WebSocket log for ${Math.round(silent)} s`);
    if (verdict === 'exit') {
      console.error(stamp(), `fast lane: no WebSocket log for ${Math.round(silent)} s; exiting so the supervisor restarts it`);
      void shutdown(1);
    }
  }, WATCHDOG_EVERY_MS));

  // Removes lane trades from blocks Envio no longer has, which a dropped `removed` notice and the repair window can both miss.
  const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
  if (!envioDatabaseUrl) {
    console.warn(stamp(), 'ENVIO_DATABASE_URL is not set: fast lane reconcile is off');
  } else {
    const envio = new Pool({ connectionString: envioDatabaseUrl });
    envioPool = envio;
    const olderThanSeconds = Number(process.env.FAST_LANE_RECONCILE_MIN_AGE_SECONDS ?? 300);
    let reconciling = false;
    timers.push(setInterval(() => {
      if (reconciling) return;
      reconciling = true;
      void (async () => {
        try {
          const { processedBlock } = await readEnvioProgress(envio);
          const report = await reconcileLaneRows(database.db, envio, { chainId: chain.id, processedBlock, olderThanSeconds });
          if (report.removed + report.forgotten > 0) console.log(stamp(), 'fast lane reconcile', report);
        } catch (error) {
          console.error(stamp(), `fast lane reconcile failed: ${redactError(error)}`);
        } finally {
          reconciling = false;
        }
      })();
    }, RECONCILE_EVERY_MS));
  }
} catch (error) {
  console.error(`fast lane failed to start: ${redactError(error)}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  // viem's keep-alive timer would hold the process open: always end with an explicit exit, and never hang longer than 10 s.
  setTimeout(() => process.exit(1), 10_000).unref();
  for (const timer of timers.splice(0)) clearInterval(timer);
  let exitCode = code;
  try {
    await lane.stop();
    await pool.end();
    await envioPool?.end();
  } catch (error) {
    console.error(`fast lane shutdown failed: ${redactError(error)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
