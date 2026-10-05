import { randomBytes } from 'node:crypto';
import { Pool, Client } from 'pg';
import { createDatabase, type Database } from '../db/client.js';
import { syncV1LegacyToReal } from '../envioSync/runSync.js';
import { syncV2ToReal } from '../envioSync/runSyncV2.js';
import { syncV4ToReal } from '../envioSync/runSyncV4.js';
import { applyEnvioPage, runTailPass, runHistoryPass, type RunPassInput } from '../envioSync/incrementalSync.js';
import { repairEnvioWindow } from '../envioSync/incrementalRepair.js';
import { STREAMS, type Stream } from '../envioSync/incrementalCursor.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { derivePonsV4PoolId } from '../launchpads/pons/v2/poolKey.js';
import type { Launch } from '../domain/types.js';

// One-shot disposable-DB measurement + offline-vs-incremental parity probe — not production code.
// REQUIRED SAFETY: refuses to run against anything whose database name does not look disposable.
// See README.md's "Incremental sync benchmark / rollback" section for the exact invocation and how
// to read the output. Never point this at the live app DB (CLAUDE.md: no trial sync there).

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required (a disposable database — see README.md)');
const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/test|disposable|bench/i.test(dbName)) {
  throw new Error(`Refusing to run against database "${dbName}" — its name must contain test/disposable/bench. `
    + 'This script writes and deletes real launches/trades/venues; never point it at the live app DB.');
}
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL ?? databaseUrl;

const CHAIN_ID = 4663;
const legacyFactory = getPonsFactorySources().find((f) => f.id === 'pons-v1-legacy')!.factory;
const v2Factory = getPonsFactorySources()[2]!;
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const PONS_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

const schema = 'envio_fixture_bench';
const tables: Record<Stream, string> = {
  'v1-launch': `${schema}."RawLaunch"`, 'v1-swap': `${schema}."RawSwap"`,
  'v2-launch': `${schema}."RawLaunchV2"`, 'v2-curve': `${schema}."RawCurveTrade"`,
  'v2-buyback': `${schema}."RawCurveBuyback"`, 'v2-lifecycle': `${schema}."RawLifecycleTransition"`,
  'v4-initialize': `${schema}."RawV4Initialize"`, 'v4-swap': `${schema}."RawV4Swap"`,
};
const oldPathTables = {
  v1: { rawLaunchTable: tables['v1-launch'], rawSwapTable: tables['v1-swap'], progressTable: `${schema}.chain_metadata` },
  v2: {
    rawLaunchV2Table: tables['v2-launch'], rawCurveTradeTable: tables['v2-curve'],
    rawCurveBuybackTable: tables['v2-buyback'], rawLifecycleTable: tables['v2-lifecycle'], progressTable: `${schema}.chain_metadata`,
  },
  v4: { rawV4InitializeTable: tables['v4-initialize'], rawV4SwapTable: tables['v4-swap'], progressTable: `${schema}.chain_metadata` },
};

function hex(n: number): string { return randomBytes(n).toString('hex'); }
function addr(seed: string): string { return `0x${seed.padEnd(40, '0').slice(0, 40)}`; }
function hash(seed: string): string { return `0x${seed.padEnd(64, '0').slice(0, 64)}`; }

interface SyntheticLaunch { token: string; pool: string; txHash: string; blockHash: string; block: number }

async function setupSchema(envioPool: Pool): Promise<void> {
  await envioPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v1-launch']} (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text, "pairTokenAddress" text,
    "poolAddress" text, "factoryAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v1-swap']} (
    id text primary key, "chainId" int, "poolAddress" text, "txFrom" text, amount0 numeric, amount1 numeric,
    "sqrtPriceX96" numeric, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v2-launch']} (
    id text primary key, "chainId" int, "tokenAddress" text, "curveAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v2-curve']} (
    id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric, "quoteAmountRaw" numeric,
    "feeRaw" numeric, "taxRaw" numeric, "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v2-buyback']} (
    id text primary key, "chainId" int, "curveAddress" text, "quoteSpentRaw" numeric, "tokensLockedRaw" numeric,
    "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v2-lifecycle']} (
    id text primary key, "chainId" int, "tokenAddress" text, phase int, kind text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v4-initialize']} (
    id text primary key, "chainId" int, "poolId" text, currency0 text, currency1 text, fee int, "tickSpacing" int,
    hooks text, "sqrtPriceX96" numeric, tick int, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables['v4-swap']} (
    id text primary key, "chainId" int, "poolId" text, sender text, "txFrom" text, amount0 numeric, amount1 numeric,
    "sqrtPriceX96" numeric, liquidity numeric, tick int, fee int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${schema}.chain_metadata (
    chain_id int primary key, latest_processed_block bigint, block_height bigint)`);
  await envioPool.query(`INSERT INTO ${schema}.chain_metadata VALUES (${CHAIN_ID}, 5000, 5000)
    ON CONFLICT (chain_id) DO UPDATE SET latest_processed_block = 5000, block_height = 5000`);
}

interface SyntheticData { v1: SyntheticLaunch[]; v2: SyntheticLaunch[]; graduated: Set<string>; insertedAt: number }

async function generateSyntheticData(envioPool: Pool, v1Count: number, v2Count: number, graduatedCount: number): Promise<SyntheticData> {
  const insertedAt = Date.now();
  const v1: SyntheticLaunch[] = [];
  const v2: SyntheticLaunch[] = [];
  const graduated = new Set<string>();

  for (let i = 0; i < v1Count; i++) {
    const token = addr(`1a${hex(4)}${i.toString(16)}`);
    const pool = addr(`1b${hex(4)}${i.toString(16)}`);
    const txHash = hash(`1c${hex(8)}${i.toString(16)}`);
    const blockHash = hash(`1d${hex(8)}${i.toString(16)}`);
    const block = 1000 + i;
    v1.push({ token, pool, txHash, blockHash, block });
    await envioPool.query(`INSERT INTO ${tables['v1-launch']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [`v1launch-${i}`, CHAIN_ID, token, addr('dead'), weth, pool, legacyFactory, block, blockHash, txHash, 1]);
    await envioPool.query(`INSERT INTO ${tables['v1-swap']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [`v1swap-${i}`, CHAIN_ID, pool, addr('trader1'), '100000000000000000', '-200000000000000000000',
        '2005366647941715384651103712059394', block + 1, hash(`1e${i}`), hash(`1f${i}`), 1, 1_700_000_000 + i]);
  }

  for (let i = 0; i < v2Count; i++) {
    const token = addr(`2a${hex(4)}${i.toString(16)}`);
    const curve = addr(`2b${hex(4)}${i.toString(16)}`);
    const txHash = hash(`2c${hex(8)}${i.toString(16)}`);
    const blockHash = hash(`2d${hex(8)}${i.toString(16)}`);
    const block = 2000 + i;
    v2.push({ token, pool: curve, txHash, blockHash, block });
    await envioPool.query(`INSERT INTO ${tables['v2-launch']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`v2launch-${i}`, CHAIN_ID, token, curve, addr('dead2'), addr('0'), block, blockHash, txHash, 1]);
    await envioPool.query(`INSERT INTO ${tables['v2-curve']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`v2curve-${i}`, CHAIN_ID, curve, 'buy', '1000000000000000000', '500000000000000000', '0', '0',
        addr('trader2'), block + 1, hash(`2e${i}`), hash(`2f${i}`), 1, 1_700_000_000 + i]);
    if (i < graduatedCount) {
      await envioPool.query(`INSERT INTO ${tables['v2-buyback']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [`v2buyback-${i}`, CHAIN_ID, curve, '100000000000000000', '50000000000000000',
          addr('trader2'), block + 2, hash(`2g${i}`), hash(`2h${i}`), 1, 1_700_000_000 + i]);
      const gradTxHash = hash(`2i${hex(8)}${i.toString(16)}`);
      const gradBlockHash = hash(`2j${hex(8)}${i.toString(16)}`);
      const gradBlock = block + 3;
      await envioPool.query(`INSERT INTO ${tables['v2-lifecycle']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`v2grad-${i}`, CHAIN_ID, token, 2, 'graduated', gradBlock, gradBlockHash, gradTxHash, 1]);
      const launchForPoolId: Launch = {
        chainId: CHAIN_ID, tokenAddress: token as `0x${string}`, name: null, symbol: null, tokenDecimals: null,
        platform: 'pons', protocolVersion: 'v2', sourceId: v2Factory.id, sourceLogId: '',
        factoryAddress: v2Factory.factory, deployerAddress: addr('dead2') as `0x${string}`,
        launchBlock: BigInt(block), launchTxHash: txHash as `0x${string}`,
        quoteAsset: { address: addr('0') as `0x${string}`, symbol: 'ETH', decimals: 18 }, lifecycleStatus: 'graduated',
      };
      const poolId = derivePonsV4PoolId(launchForPoolId, { fee: 0, tickSpacing: 60 }, PONS_HOOK);
      const [currency0, currency1] = token.toLowerCase() < addr('0').toLowerCase() ? [token, addr('0')] : [addr('0'), token];
      await envioPool.query(`INSERT INTO ${tables['v4-initialize']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [`v4init-${i}`, CHAIN_ID, poolId, currency0, currency1, 0, 60, PONS_HOOK,
          '2005366647941715384651103712059394', 0, gradBlock, gradBlockHash, gradTxHash, 1]);
      await envioPool.query(`INSERT INTO ${tables['v4-swap']} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [`v4swap-${i}`, CHAIN_ID, poolId, addr('trader3'), addr('trader3'), '100000000000000000', '-200000000000000000000',
          '2005366647941715384651103712059394', '0', 0, 0, gradBlock + 1, hash(`2k${i}`), hash(`2l${i}`), 1, 1_700_000_000 + i]);
      graduated.add(token.toLowerCase());
    }
  }
  return { v1, v2, graduated, insertedAt };
}

interface CanonicalKeys { launches: Set<string>; trades: Set<string>; v4Venues: Set<string> }

async function captureKeys(db: Database): Promise<CanonicalKeys> {
  const launches = await db.$client.query(`SELECT token_address FROM launches WHERE chain_id = $1`, [CHAIN_ID]);
  const trades = await db.$client.query(`SELECT tx_hash, log_index FROM trades WHERE chain_id = $1`, [CHAIN_ID]);
  const v4Venues = await db.$client.query(`SELECT ref FROM venues WHERE chain_id = $1 AND kind = 'v4_pool'`, [CHAIN_ID]);
  return {
    launches: new Set((launches.rows as { token_address: string }[]).map((r) => r.token_address.toLowerCase())),
    trades: new Set((trades.rows as { tx_hash: string; log_index: number }[]).map((r) => `${r.tx_hash.toLowerCase()}:${r.log_index}`)),
    v4Venues: new Set((v4Venues.rows as { ref: string }[]).map((r) => r.ref.toLowerCase())),
  };
}

function diffSets(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[] } {
  return { onlyA: [...a].filter((x) => !b.has(x)), onlyB: [...b].filter((x) => !a.has(x)) };
}

async function wipeAllSyntheticRows(db: Database): Promise<void> {
  await db.$client.query('DELETE FROM trades WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM venues WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM lifecycle_transitions WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM launches WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM envio_sync_cursors WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM unresolved_events WHERE chain_id = $1', [CHAIN_ID]);
  await db.$client.query('DELETE FROM sources WHERE id LIKE $1', ['pons-v2-v4:%']);
}

async function main() {
  const { db, pool } = createDatabase(databaseUrl!);
  const envioPool = new Pool({ connectionString: envioDatabaseUrl });
  const v1Count = Number(process.env.BENCH_V1_LAUNCHES ?? 10);
  const v2Count = Number(process.env.BENCH_V2_LAUNCHES ?? 10);
  const graduatedCount = Number(process.env.BENCH_GRADUATED ?? 3);

  console.log(`Disposable-DB incremental sync benchmark against "${dbName}" (v1=${v1Count}, v2=${v2Count}, graduated=${graduatedCount}).`);
  await wipeAllSyntheticRows(db);
  await setupSchema(envioPool);
  await envioPool.query(`TRUNCATE ${tables['v1-launch']}, ${tables['v1-swap']}, ${tables['v2-launch']}, ${tables['v2-curve']}, `
    + `${tables['v2-buyback']}, ${tables['v2-lifecycle']}, ${tables['v4-initialize']}, ${tables['v4-swap']}`);
  const synthetic = await generateSyntheticData(envioPool, v1Count, v2Count, graduatedCount);
  console.log(`Generated ${synthetic.v1.length} V1 + ${synthetic.v2.length} V2 launches (${synthetic.graduated.size} graduated with a V4 pool).`);

  // ---- Phase A: the old full-table path, as the known-correct reference for key parity ----
  const v1RpcClient = {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'name') return 'Bench Token';
      if (functionName === 'symbol') return 'BENCH';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return synthetic.v1.find((l) => l.token.toLowerCase() === address.toLowerCase())!.pool;
      if (functionName === 'graduationStatus') return [0n, 0n, false];
      throw new Error(`unexpected v1 functionName ${functionName}`);
    },
  };
  const v2RpcClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'name') return 'Bench Token V2';
      if (functionName === 'symbol') return 'BENCH2';
      if (functionName === 'decimals') return 18;
      throw new Error(`unexpected v2 functionName ${functionName}`);
    },
  };
  const phaseAStart = performance.now();
  await syncV1LegacyToReal(envioPool, db, oldPathTables.v1, v1RpcClient);
  await syncV2ToReal(envioPool, db, oldPathTables.v2, v2RpcClient);
  await syncV4ToReal(envioPool, db, oldPathTables.v4);
  const phaseAMs = performance.now() - phaseAStart;
  const oldKeys = await captureKeys(db);
  console.log(`Phase A (old full-table path): ${phaseAMs.toFixed(0)}ms — `
    + `${oldKeys.launches.size} launches, ${oldKeys.trades.size} trades, ${oldKeys.v4Venues.size} V4 venues.`);
  await wipeAllSyntheticRows(db);

  // ---- Phase B: the new incremental path, with latency + notification measurement ----
  const listener = new Client({ connectionString: databaseUrl });
  await listener.connect();
  const notifiedAt: number[] = [];
  listener.on('notification', () => notifiedAt.push(Date.now()));
  await listener.query('LISTEN launchpad_events');

  const fence = 5000n;
  const passInput: RunPassInput = { chainId: CHAIN_ID, envioPool, appDb: db, fence, limit: 1000, tables };
  for (const stream of STREAMS) {
    const r = await applyEnvioPage(envioPool, db, { chainId: CHAIN_ID, stream, lane: 'history', fence, limit: 1000, tables });
    console.log(`  ${stream}: applied=${r.applied} unresolved=${r.unresolved}`);
  }
  // The per-row raw-visibility timestamp is `synthetic.insertedAt` (when this script wrote the rows) —
  // there is no earlier "Envio committed it" timestamp to observe here (no live Envio in this
  // disposable probe), so this specifically measures insert-to-app-commit for the whole synthetic
  // batch, not a true per-trade visibility latency. Labeled as a proxy per the spec's own caution.
  const batchCommitMs = Date.now() - synthetic.insertedAt;
  await new Promise((resolve) => setTimeout(resolve, 500)); // let pg_notify deliveries land
  const sseProxyMs = notifiedAt.length > 0 ? Math.max(...notifiedAt) - synthetic.insertedAt : NaN;
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();

  const newKeys = await captureKeys(db);
  console.log(`Phase B (incremental path): batch insert-to-commit ${batchCommitMs}ms, `
    + `insert-to-SSE-delivery proxy ${Number.isNaN(sseProxyMs) ? 'n/a (no notifications received)' : `${sseProxyMs}ms`} — `
    + `${newKeys.launches.size} launches, ${newKeys.trades.size} trades, ${newKeys.v4Venues.size} V4 venues.`);

  // ---- Key parity ----
  const launchDiff = diffSets(oldKeys.launches, newKeys.launches);
  const tradeDiff = diffSets(oldKeys.trades, newKeys.trades);
  const venueDiff = diffSets(oldKeys.v4Venues, newKeys.v4Venues);
  const parityOk = launchDiff.onlyA.length === 0 && launchDiff.onlyB.length === 0
    && tradeDiff.onlyA.length === 0 && tradeDiff.onlyB.length === 0
    && venueDiff.onlyA.length === 0 && venueDiff.onlyB.length === 0;
  console.log(`\nKey parity (old full-table path vs. incremental path): ${parityOk ? 'MATCH' : 'MISMATCH'}`);
  if (!parityOk) {
    console.log('  launches only in old:', launchDiff.onlyA, 'only in new:', launchDiff.onlyB);
    console.log('  trades only in old:', tradeDiff.onlyA, 'only in new:', tradeDiff.onlyB);
    console.log('  v4 venues only in old:', venueDiff.onlyA, 'only in new:', venueDiff.onlyB);
  }

  // ---- Restart idempotence ----
  let restartApplied = 0;
  for (const stream of STREAMS) {
    const result = await applyEnvioPage(envioPool, db, { chainId: CHAIN_ID, stream, lane: 'history', fence, limit: 1000, tables });
    restartApplied += result.applied;
  }
  console.log(`\nRestart (re-running the same history pass): ${restartApplied} newly applied (expect 0 — idempotent).`);

  // ---- Repair on already-correct data ----
  const repairReport = await repairEnvioWindow(envioPool, db, { chainId: CHAIN_ID, fence, depth: 500n, tables });
  console.log(`Repair pass on correctly-synced data: ${repairReport.changedLaunchKeys.length} launches changed (expect 0).`);

  // ---- Tail/history pass smoke test (exercises runTailPass/runHistoryPass directly) ----
  await runTailPass(passInput);
  await runHistoryPass(passInput);

  console.log('\n429/provider-throttling and chain-to-Envio lag are NOT measured by this disposable-DB probe — '
    + 'they require a live Envio/HyperSync connection. See README.md\'s live-probe section.');

  const COMMIT_GATE_MS = 3000;
  const RENDER_PROXY_GATE_MS = 5000;
  const commitPass = batchCommitMs <= COMMIT_GATE_MS;
  const ssePass = Number.isNaN(sseProxyMs) || sseProxyMs <= RENDER_PROXY_GATE_MS;
  const restartPass = restartApplied === 0;
  const repairPass = repairReport.changedLaunchKeys.length === 0;
  const overallPass = parityOk && commitPass && ssePass && restartPass && repairPass;
  console.log(`\n${overallPass ? 'PASS' : 'FAIL'}: parity=${parityOk} commit=${batchCommitMs}ms(<=${COMMIT_GATE_MS}) `
    + `sseProxy=${Number.isNaN(sseProxyMs) ? 'n/a' : sseProxyMs}ms(<=${RENDER_PROXY_GATE_MS}) restart=${restartPass} repair=${repairPass}`);

  await wipeAllSyntheticRows(db);
  await envioPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await envioPool.end();
  if (!overallPass) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
