import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioSyncCursors, launches, venues, trades, unresolvedEvents } from '../db/schema.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { derivePonsV4PoolId } from '../launchpads/pons/v2/poolKey.js';
import type { Launch } from '../domain/types.js';
import type { Lane, Stream } from './incrementalCursor.js';
import { applyEnvioPage, confirmedSourceBlock, retryUnresolvedEvents } from './incrementalSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

const envioPool = new Pool({ connectionString: databaseUrl });
const rawLaunchTable = 'envio_fixture_incremental."RawLaunch"';
const rawSwapTable = 'envio_fixture_incremental."RawSwap"';
const rawLaunchV2Table = 'envio_fixture_incremental."RawLaunchV2"';
const rawLifecycleTable = 'envio_fixture_incremental."RawLifecycleTransition"';
const rawV4InitializeTable = 'envio_fixture_incremental."RawV4Initialize"';
const chainId = 4663; // hydrateV1Launch binds launch.chainId from the factory source, always 4663 — not test-swappable.
const legacyFactory = getPonsFactorySources().find((factory) => factory.id === 'pons-v1-legacy')!.factory;
const v2Factory = getPonsFactorySources()[2]!;
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const PONS_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const zeroAddress = '0x0000000000000000000000000000000000000000';
const tables = {
  'v1-launch': rawLaunchTable, 'v1-swap': rawSwapTable, 'v2-launch': rawLaunchV2Table,
  'v2-lifecycle': rawLifecycleTable, 'v4-initialize': rawV4InitializeTable,
};

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
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawLaunchV2Table} (
    id text primary key, "chainId" int, "tokenAddress" text, "curveAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawLifecycleTable} (
    id text primary key, "chainId" int, "tokenAddress" text, phase int, kind text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawV4InitializeTable} (
    id text primary key, "chainId" int, "poolId" text, currency0 text, currency1 text, fee int, "tickSpacing" int,
    hooks text, "sqrtPriceX96" numeric, tick int, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`TRUNCATE ${rawLaunchTable}, ${rawSwapTable}, ${rawLaunchV2Table}, ${rawLifecycleTable}, ${rawV4InitializeTable}`);
});

// Every test reads its own stream from genesis (via resetCursor), so a row left over from an earlier
// test's insert would otherwise be re-read too — scope each test to only the rows it inserts itself.
// Also clear any unresolved-event rows a prior test enqueued: retryUnresolvedEvents claims by
// (chainId, stream) only, so a leftover row would otherwise be claimed (and "resolved" as
// gone-from-raw, since the fixture truncate above removes its raw row too) by an unrelated test.
beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${rawLaunchTable}, ${rawSwapTable}, ${rawLaunchV2Table}, ${rawLifecycleTable}, ${rawV4InitializeTable}`);
  await db.delete(unresolvedEvents).where(eq(unresolvedEvents.chainId, chainId));
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture_incremental CASCADE');
  for (const token of testTokens) {
    await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    await db.delete(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token)));
    await db.delete(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
  }
  await db.delete(envioSyncCursors).where(eq(envioSyncCursors.chainId, chainId));
  await db.delete(unresolvedEvents).where(eq(unresolvedEvents.chainId, chainId));
  await db.delete(envioSyncCursors).where(eq(envioSyncCursors.chainId, 999777));
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
  // trades' primary key is (chainId, txHash, logIndex) — derive a per-row txHash from `id` so two
  // different rows (in the same test or across tests) can never collide and silently no-op an insert.
  const txHash = `0x${createHash('sha256').update(id).digest('hex')}`;
  await envioPool.query(`INSERT INTO ${rawSwapTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, chainId, poolAddress, '0x1234567890123456789012345678901234567890', amount0, amount1,
      '2005366647941715384651103712059394', blockNumber, `0x${'cd'.repeat(32)}`,
      txHash, logIndex, 1_700_000_000]);
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

  it('retries an unresolved swap durably, independent of the moving cursor, once its launch arrives', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress, txHash } = freshToken();
    // Swap-before-launch, same as the sibling test — but this time the launch does arrive afterwards.
    await insertSwapRow(`retry-${token}`, poolAddress, 700, 1, '100000000000000000', '-200000000000000000000');
    const firstPass = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(firstPass.unresolved).toBe(1);

    const unresolvedBefore = await retryUnresolvedEvents(envioPool, db, { chainId, stream: 'v1-swap', limit: 10, tables });
    expect(unresolvedBefore).toBe(0); // the launch still doesn't exist — retry correctly finds it still unresolved

    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 690, 1);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables });

    const resolvedCount = await retryUnresolvedEvents(envioPool, db, {
      chainId, stream: 'v1-swap', limit: 10, tables, now: new Date(Date.now() + 61_000),
    });
    expect(resolvedCount).toBe(1);
    const tradeRows = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRows).toHaveLength(1);
  });
});

describe('applyEnvioPage: minimal launch records and deferred metadata', () => {
  it('persists a V1 launch immediately with name/symbol/decimals null, pending core-metadata enrichment, and prices its trade as null while they stay unknown', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, 1);

    const launchResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(launchResult.applied).toBe(1); // visible before any RPC metadata call

    const [launchRow] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(launchRow.name).toBeNull();
    expect(launchRow.symbol).toBeNull();
    expect(launchRow.tokenDecimals).toBeNull();
    expect(launchRow.coreMetadataReadState).toBe('pending');
    expect(launchRow.lifecycleStatus).toBe('trading'); // no graduation RPC call either; safe default

    await insertSwapRow(`swap-${token}`, poolAddress, 610, 1, '100000000000000000', '-200000000000000000000');
    const swapResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(swapResult.applied).toBe(1);
    const [tradeRow] = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRow.priceNumeratorRaw).toBeNull();
    expect(tradeRow.priceDenominatorRaw).toBeNull();
    // The raw amount is still recorded exactly — only the derived price is withheld.
    expect(tradeRow.tokenAmountRaw).toBe('200000000000000000000');
  });
});

describe('applyEnvioPage: transactional page application', () => {
  it('rolls back the whole page and does not advance the cursor when a later row fails to hydrate', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 300, 1);
    const launchResult = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables,
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
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables,
    });
    expect(first.applied).toBe(1);

    // Simulates a process restart: the durable cursor (not process memory) decides where this resumes.
    const restarted = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables,
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
      chainId, stream: 'v1-launch', lane: 'history', fence: 1000n, limit: 10, tables,
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
      chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables,
    });
    expect(history.applied).toBe(1);

    const tail = await applyEnvioPage(envioPool, db, {
      chainId, stream: 'v1-launch', lane: 'tail', fence, limit: 10, tables,
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

describe('applyEnvioPage: V2 graduation opens the matching V4 venue', () => {
  it('applies v2-launch, then v2-lifecycle, then v4-initialize to open a v4_pool venue on the launch (not looked up by tokenAddress as a pool ref)', async () => {
    await resetCursor('v2-launch', 'history');
    await resetCursor('v2-lifecycle', 'history');
    await resetCursor('v4-initialize', 'history');
    const fresh = freshToken();
    const curveAddress = fresh.poolAddress;
    const launchTxHash = fresh.txHash;
    // derivePonsV4PoolId strictly validates a real 20-byte address (freshToken()'s own 44-hex-char
    // values are fine for plain string comparisons elsewhere, but not here) — reshape to exactly 40 hex chars.
    const token = `0x${fresh.token.slice(2).padStart(40, '0').slice(-40)}`;
    testTokens.push(token);

    await envioPool.query(`INSERT INTO ${rawLaunchV2Table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`v2launch-${token}`, chainId, token, curveAddress, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', zeroAddress,
        700, `0x${'a7'.repeat(32)}`, launchTxHash, 1]);
    const launchResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(launchResult.applied).toBe(1);

    const gradTxHash = `0x${createHash('sha256').update(`grad-${token}`).digest('hex')}`;
    const gradBlockHash = `0x${createHash('sha256').update(`gradhash-${token}`).digest('hex')}`;
    await envioPool.query(`INSERT INTO ${rawLifecycleTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`v2grad-${token}`, chainId, token, 2, 'graduated', 710, gradBlockHash, gradTxHash, 1]);
    const lifecycleResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(lifecycleResult.applied).toBe(1);

    const launchForPoolId: Launch = {
      chainId, tokenAddress: token as `0x${string}`, name: null, symbol: null, tokenDecimals: null,
      platform: 'pons', protocolVersion: 'v2', sourceId: v2Factory.id, sourceLogId: '',
      factoryAddress: v2Factory.factory, deployerAddress: token as `0x${string}`,
      launchBlock: 700n, launchTxHash: launchTxHash as `0x${string}`,
      quoteAsset: { address: zeroAddress as `0x${string}`, symbol: 'ETH', decimals: 18 }, lifecycleStatus: 'graduated',
    };
    const poolId = derivePonsV4PoolId(launchForPoolId, { fee: 0, tickSpacing: 60 }, PONS_HOOK);
    const [currency0, currency1] = token.toLowerCase() < zeroAddress ? [token, zeroAddress] : [zeroAddress, token];
    await envioPool.query(`INSERT INTO ${rawV4InitializeTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`v4init-${token}`, chainId, poolId, currency0, currency1, 0, 60, PONS_HOOK,
        '2005366647941715384651103712059394', 0, 710, gradBlockHash, gradTxHash, 1]);
    const initResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v4-initialize', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(initResult.applied).toBe(1);
    expect(initResult.unresolved).toBe(0);

    const v4Venues = await db.select().from(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token), eq(venues.kind, 'v4_pool')));
    expect(v4Venues).toHaveLength(1);
    expect(v4Venues[0]!.ref).toBe(poolId.toLowerCase());
  });
});

describe('confirmedSourceBlock', () => {
  it('reports the advanced watermark for a stream whose pass applied zero rows (an empty range)', async () => {
    await resetCursor('v1-launch', 'history');
    // No raw rows inserted at all — applyEnvioPage still advances the watermark on an empty page.
    const result = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 800n, limit: 10, tables });
    expect(result.applied).toBe(0);
    const confirmed = await confirmedSourceBlock(db, chainId, ['v1-launch'], 'history');
    expect(confirmed).toBe(800n);
  });

  it('caps a stream at the block before its earliest unresolved event — a swap whose launch has not arrived yet', async () => {
    await resetCursor('v1-swap', 'history');
    const { poolAddress } = freshToken();
    await insertSwapRow(`gap-${poolAddress}`, poolAddress, 500, 1, '100000000000000000', '-200000000000000000000');
    const result = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 900n, limit: 10, tables });
    expect(result.unresolved).toBe(1);
    // The cursor itself read all the way to 900, but the stream cannot confirm past the unresolved
    // gap at block 500 — coverage must never claim a block it only read past, not actually applied.
    const confirmed = await confirmedSourceBlock(db, chainId, ['v1-swap'], 'history');
    expect(confirmed).toBe(499n);
  });

  it('tracks tail and history independently for the same stream', async () => {
    await resetCursor('v1-launch', 'tail');
    await resetCursor('v1-launch', 'history');
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'tail', fence: 900n, limit: 10, tables });
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 300n, limit: 10, tables });
    expect(await confirmedSourceBlock(db, chainId, ['v1-launch'], 'tail')).not.toBe(await confirmedSourceBlock(db, chainId, ['v1-launch'], 'history'));
    expect(await confirmedSourceBlock(db, chainId, ['v1-launch'], 'history')).toBe(300n);
  });

  it('stays null (provisional, never a fabricated number) while any required stream has never been synced', async () => {
    const neverSyncedChain = 999777;
    const confirmed = await confirmedSourceBlock(db, neverSyncedChain, ['v1-launch', 'v1-swap'], 'history');
    expect(confirmed).toBeNull();
  });
});
