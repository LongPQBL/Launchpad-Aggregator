import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioSyncCursors, launches, venues, trades } from '../db/schema.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import type { Lane, Stream } from './incrementalCursor.js';
import { applyEnvioPage } from './incrementalSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

const envioPool = new Pool({ connectionString: databaseUrl });
const rawLaunchTable = 'envio_fixture_incremental."RawLaunch"';
const rawSwapTable = 'envio_fixture_incremental."RawSwap"';
const chainId = 4663; // hydrateV1Launch binds launch.chainId from the factory source, always 4663 — not test-swappable.
const legacyFactory = getPonsFactorySources().find((factory) => factory.id === 'pons-v1-legacy')!.factory;
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const tables = { 'v1-launch': rawLaunchTable, 'v1-swap': rawSwapTable };

function rpcClientFor(poolAddress: string) {
  return { readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'name') return 'Test Token';
    if (functionName === 'symbol') return 'TEST';
    if (functionName === 'decimals') return 18;
    if (functionName === 'liquidityPool') return poolAddress;
    if (functionName === 'graduationStatus') return [0n, 0n, false];
    throw new Error(`unexpected functionName ${functionName}`);
  } };
}

const testTokens: string[] = [];

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_incremental');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawLaunchTable} (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "factoryAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawSwapTable} (
    id text primary key, "chainId" int, "poolAddress" text, "txFrom" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`TRUNCATE ${rawLaunchTable}, ${rawSwapTable}`);
});

// Every test reads its own stream from genesis (via resetCursor), so a row left over from an earlier
// test's insert would otherwise be re-read too — scope each test to only the rows it inserts itself.
beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${rawLaunchTable}, ${rawSwapTable}`);
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture_incremental CASCADE');
  for (const token of testTokens) {
    await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    await db.delete(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token)));
    await db.delete(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
  }
  await db.delete(envioSyncCursors).where(eq(envioSyncCursors.chainId, chainId));
  await pool.end();
  await envioPool.end();
});

// Each test resets the specific (stream, lane) cursor row it exercises, instead of relying on
// whatever an earlier test left behind — the stream/lane identifiers are a fixed, shared set, so
// tests must not depend on execution order.
async function resetCursor(stream: Stream, lane: Lane): Promise<void> {
  await db.delete(envioSyncCursors).where(and(
    eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, stream), eq(envioSyncCursors.lane, lane),
  ));
}

let nextSuffix = 0;
function freshToken(): { token: string; poolAddress: string; txHash: string } {
  nextSuffix += 1;
  const n = nextSuffix.toString(16).padStart(4, '0');
  const token = `0x10${n}000000000000000000000000000000000001`;
  const poolAddress = `0x20${n}000000000000000000000000000000000001`;
  const txHash = `0x30${n}000000000000000000000000000000000000000000000000000000000001`;
  testTokens.push(token);
  return { token, poolAddress, txHash };
}
async function insertLaunchRow(id: string, token: string, poolAddress: string, txHash: string, blockNumber: number, logIndex: number): Promise<void> {
  await envioPool.query(`INSERT INTO ${rawLaunchTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, chainId, token, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', weth, poolAddress, legacyFactory,
      blockNumber, `0x${'ab'.repeat(32)}`, txHash, logIndex]);
}
async function insertSwapRow(
  id: string, poolAddress: string, blockNumber: number, logIndex: number, amount0: string, amount1: string,
): Promise<void> {
  await envioPool.query(`INSERT INTO ${rawSwapTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, chainId, poolAddress, '0x1234567890123456789012345678901234567890', amount0, amount1,
      '2005366647941715384651103712059394', blockNumber, `0x${'cd'.repeat(32)}`,
      `0x${'ef'.repeat(32)}`, logIndex, 1_700_000_000]);
}

describe('applyEnvioPage: downstream dependency ordering', () => {
  it('reports a swap whose launch/venue is missing as unresolved, without applying it, while still advancing the cursor', async () => {
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress } = freshToken();
    await insertSwapRow(`unresolved-${token}`, poolAddress, 200, 1, '100000000000000000', '-200000000000000000000');

    const result = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(result.applied).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.cursor.position.blockNumber).toBe(200n);
    const tradeRows = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRows).toHaveLength(0);
  });
});

describe('applyEnvioPage: transactional page application', () => {
  it('rolls back the whole page and does not advance the cursor when a later row fails to hydrate', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 300, 1);
    const launchResult = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(launchResult.applied).toBe(1);

    await insertSwapRow(`ok-${token}`, poolAddress, 310, 1, '100000000000000000', '-200000000000000000000');
    // Both legs positive — hydrateV1SwapFromDecoded throws "Invalid V3 swap amounts" for this row.
    await insertSwapRow(`bad-${token}`, poolAddress, 320, 1, '100000000000000000', '200000000000000000000');

    await expect(applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 1000n, limit: 10, tables }))
      .rejects.toThrow(/Invalid V3 swap amounts/);

    const tradeRows = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRows).toHaveLength(0); // the valid first row was rolled back along with the failing second row
    const [cursorRow] = await db.select().from(envioSyncCursors)
      .where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, 'v1-swap'), eq(envioSyncCursors.lane, 'history')));
    expect(cursorRow?.blockNumber ?? 0n).toBe(0n); // unchanged from its reset genesis position
  });
});

describe('applyEnvioPage: replay after restart', () => {
  it('re-running the same inputs after a cursor has advanced applies nothing new and does not duplicate rows', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 400, 1);

    const first = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(first.applied).toBe(1);

    // Simulates a process restart: the durable cursor (not process memory) decides where this resumes.
    const restarted = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(restarted.applied).toBe(0);
    expect(restarted.unresolved).toBe(0);

    const launchRows = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(launchRows).toHaveLength(1);
  });
});

describe('applyEnvioPage: duplicate raw events', () => {
  it('two raw rows for the same logical launch produce exactly one app-table row', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`dup-a-${token}`, token, poolAddress, txHash, 500, 1);
    await insertLaunchRow(`dup-b-${token}`, token, poolAddress, txHash, 500, 2);

    const result = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(result.applied).toBe(2); // both rows processed...
    const launchRows = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(launchRows).toHaveLength(1); // ...but only one launch exists
  });
});

describe('applyEnvioPage: overlap between history and tail lanes', () => {
  it('two independent lanes reading the same raw row do not duplicate the app row', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-launch', 'tail');
    const { token, poolAddress, txHash } = freshToken();
    // fence - TAIL_SEED_DEPTH(500) = 50, so a fresh tail cursor's seed (block 50) still covers block 100.
    await insertLaunchRow(`overlap-${token}`, token, poolAddress, txHash, 100, 1);
    const fence = 550n;

    const history = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(history.applied).toBe(1);

    const tail = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'tail', fence, limit: 10, tables, v1RpcClient: rpcClientFor(poolAddress),
    });
    expect(tail.applied).toBe(1); // tail independently reads and confirms the same row

    const launchRows = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(launchRows).toHaveLength(1);
    const cursorRows = await db.select().from(envioSyncCursors)
      .where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, 'v1-launch')));
    const lanesSeen = new Set(cursorRows.map((row) => row.lane));
    expect(lanesSeen.has('tail')).toBe(true);
    expect(lanesSeen.has('history')).toBe(true);
  });
});
