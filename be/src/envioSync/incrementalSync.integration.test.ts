import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioSyncCursors, launches, venues, trades, unresolvedEvents, sources } from '../db/schema.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { derivePonsV4PoolId } from '../launchpads/pons/v2/poolKey.js';
import type { Launch } from '../domain/types.js';
import { claimSyncCursor, advanceSyncCursor, type Lane, type Stream } from './incrementalCursor.js';
import { applyEnvioPage, confirmedSourceBlock, retryUnresolvedEvents, syncSourceCoverage, repriceNullPricedTrades, lookupLaunch } from './incrementalSync.js';

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

describe('applyEnvioPage: v2-lifecycle status reflects the latest transition by block order (final review, Important 9)', () => {
  it('does not regress lifecycle_status to an older transition that is merely applied later via a different lane', async () => {
    await resetCursor('v2-launch', 'history');
    await resetCursor('v2-lifecycle', 'tail');
    await resetCursor('v2-lifecycle', 'history');
    const { token, poolAddress: curveAddress, txHash: launchTxHash } = freshToken();

    await envioPool.query(`INSERT INTO ${rawLaunchV2Table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`v2launch-${token}`, chainId, token, curveAddress, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', zeroAddress,
        700, `0x${'a7'.repeat(32)}`, launchTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 1000n, limit: 10, tables });

    // The tail lane (seeded near head) picks up the chronologically LATER transition (graduated,
    // block 720) first — the history lane (still crawling from genesis) has not reached either
    // transition for this token yet. Independent per-lane cursors make this ordering realistic.
    const gradTxHash = `0x${createHash('sha256').update(`order-grad-${token}`).digest('hex')}`;
    await envioPool.query(`INSERT INTO ${rawLifecycleTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`order-grad-${token}`, chainId, token, 2, 'graduated', 720, `0x${'b7'.repeat(32)}`, gradTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'tail', fence: 1000n, limit: 10, tables });
    let [launchRow] = await db.select().from(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
    expect(launchRow!.lifecycleStatus).toBe('graduated');

    // The history lane now reaches the chronologically EARLIER transition (swept, block 710) for
    // the same token and applies it second.
    const sweptTxHash = `0x${createHash('sha256').update(`order-swept-${token}`).digest('hex')}`;
    await envioPool.query(`INSERT INTO ${rawLifecycleTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`order-swept-${token}`, chainId, token, 1, 'swept', 710, `0x${'c7'.repeat(32)}`, sweptTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'history', fence: 1000n, limit: 10, tables });
    [launchRow] = await db.select().from(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
    expect(launchRow!.lifecycleStatus).toBe('graduated'); // must not regress to the older 'swept'
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

  it('queues a V4 Initialize as unresolved (not silently skipped) when its matching graduation has not been applied by v2-lifecycle yet (final review, Important 5)', async () => {
    await resetCursor('v2-launch', 'history');
    await resetCursor('v2-lifecycle', 'tail');
    await resetCursor('v2-lifecycle', 'history');
    await resetCursor('v4-initialize', 'history');
    const fresh = freshToken();
    const curveAddress = fresh.poolAddress;
    const launchTxHash = fresh.txHash;
    const token = `0x${fresh.token.slice(2).padStart(40, '0').slice(-40)}`;
    testTokens.push(token);

    await envioPool.query(`INSERT INTO ${rawLaunchV2Table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`v2launch-${token}`, chainId, token, curveAddress, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', zeroAddress,
        700, `0x${'a7'.repeat(32)}`, launchTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 1000n, limit: 10, tables });

    // The graduation's lifecycle transition is never inserted/applied in this test — the two
    // streams page independently, so the V4 Initialize for a real, imminent Pons graduation can
    // legitimately be read before v2-lifecycle has caught up to the same block.
    const gradTxHash = `0x${createHash('sha256').update(`late-grad-${token}`).digest('hex')}`;
    const gradBlockHash = `0x${createHash('sha256').update(`late-gradhash-${token}`).digest('hex')}`;
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
      [`v4init-late-${token}`, chainId, poolId, currency0, currency1, 0, 60, PONS_HOOK,
        '2005366647941715384651103712059394', 0, 710, gradBlockHash, gradTxHash, 1]);

    const initResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v4-initialize', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(initResult.applied).toBe(0);
    expect(initResult.unresolved).toBe(1);
    let v4Venues = await db.select().from(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token), eq(venues.kind, 'v4_pool')));
    expect(v4Venues).toHaveLength(0);

    // v2-lifecycle now catches up with the matching graduation — a retry must open the venue, not
    // leave it silently lost.
    await envioPool.query(`INSERT INTO ${rawLifecycleTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`v2grad-late-${token}`, chainId, token, 2, 'graduated', 710, gradBlockHash, gradTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'history', fence: 1000n, limit: 10, tables });
    const resolvedCount = await retryUnresolvedEvents(envioPool, db, {
      chainId, stream: 'v4-initialize', limit: 10, tables, now: new Date(Date.now() + 61_000),
    });
    expect(resolvedCount).toBe(1);
    v4Venues = await db.select().from(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token), eq(venues.kind, 'v4_pool')));
    expect(v4Venues).toHaveLength(1);
    expect(v4Venues[0]!.ref).toBe(poolId.toLowerCase());
  });

  it('settles a V4 Initialize as permanently skipped (not stuck retrying forever) once v2-lifecycle has confirmed past its block with no matching graduation (final review, Important 5)', async () => {
    await resetCursor('v2-lifecycle', 'tail');
    await resetCursor('v2-lifecycle', 'history');
    await resetCursor('v4-initialize', 'tail');
    await resetCursor('v4-initialize', 'history');
    const { token } = freshToken();
    const nonPonsTxHash = `0x${createHash('sha256').update(`not-pons-${token}`).digest('hex')}`;
    await envioPool.query(`INSERT INTO ${rawV4InitializeTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`v4init-noise-${token}`, chainId, `0x${'ee'.repeat(32)}`, token, zeroAddress, 500, 10, zeroAddress,
        '2005366647941715384651103712059394', 0, 500, `0x${'ff'.repeat(32)}`, nonPonsTxHash, 1]);

    const initResult = await applyEnvioPage(envioPool, db, { chainId, stream: 'v4-initialize', lane: 'history', fence: 1000n, limit: 10, tables });
    expect(initResult.unresolved).toBe(1); // v2-lifecycle has never been synced yet — still ambiguous

    // v2-lifecycle (with nothing graduated at this address) now confirms past block 500 — this row
    // is now provably not a Pons pool, not merely "not yet applied".
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'history', fence: 600n, limit: 10, tables });
    const resolvedCount = await retryUnresolvedEvents(envioPool, db, {
      chainId, stream: 'v4-initialize', limit: 10, tables, now: new Date(Date.now() + 61_000),
    });
    expect(resolvedCount).toBe(1); // settled (skipped), not left to retry forever
    const remaining = await retryUnresolvedEvents(envioPool, db, { chainId, stream: 'v4-initialize', limit: 10, tables });
    expect(remaining).toBe(0);
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

  it('never claims past the last row actually read when a page is cut short by its own limit (final review, Critical 3/Important 4)', async () => {
    await resetCursor('v1-launch', 'history');
    const a = freshToken();
    const b = freshToken();
    // Two rows exist well below the fence, but limit:1 forces the page to stop after the first —
    // confirmedSourceBlock must not claim the fence (950) when only block 100 was actually read.
    await insertLaunchRow(`trunc-a-${a.token}`, a.token, a.poolAddress, a.txHash, 100, 1);
    await insertLaunchRow(`trunc-b-${b.token}`, b.token, b.poolAddress, b.txHash, 200, 1);
    const result = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 950n, limit: 1, tables });
    expect(result.applied).toBe(1);
    expect(result.cursor.position.blockNumber).toBe(100n);
    const confirmed = await confirmedSourceBlock(db, chainId, ['v1-launch'], 'history');
    expect(confirmed).toBe(99n);
  });
});

describe('syncSourceCoverage (final review, Critical 3)', () => {
  const v1FactoryIds = getPonsFactorySources().filter((f) => f.version === 'v1').flatMap((f) => [f.id, `${f.id}-trades`]);
  async function seedSource(id: string): Promise<void> {
    await db.insert(sources).values({
      id, chainId, version: 'v1', factoryAddress: zeroAddress, startBlock: 0n, scannedToBlock: 0n, confirmedToBlock: 0n, status: 'backfilling',
    }).onConflictDoUpdate({ target: sources.id, set: { confirmedToBlock: 0n, scannedToBlock: 0n, status: 'backfilling' } });
  }
  afterAll(async () => {
    // These ids are shared, chain-global fixture rows other test files also seed/read (e.g.
    // runSyncV2.integration.test.ts) — reset rather than delete, both because launches created in
    // this block still reference them via a foreign key until the file-level afterAll runs, and to
    // avoid leaving a stale confirmed_to_block for another file's test to read.
    for (const id of [...v1FactoryIds, v2Factory.id, 'pons-v2-curve', 'pons-v2-lifecycle']) {
      await db.update(sources).set({ confirmedToBlock: 0n, scannedToBlock: 0n, status: 'backfilling' }).where(eq(sources.id, id));
    }
  });

  it('advances confirmed_to_block and flips status to caught_up for v1, v2 launch, and v2 trade/lifecycle sources once their streams reach head — never left frozen at insert time (final review, Critical 3)', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    await resetCursor('v2-launch', 'history');
    await resetCursor('v2-lifecycle', 'history');
    for (const id of [...v1FactoryIds, v2Factory.id, 'pons-v2-curve', 'pons-v2-lifecycle']) await seedSource(id);

    const v1 = freshToken();
    await insertLaunchRow(`cov-v1-${v1.token}`, v1.token, v1.poolAddress, v1.txHash, 100, 1);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 500n, limit: 10, tables });
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 500n, limit: 10, tables });

    const v2 = freshToken();
    await envioPool.query(`INSERT INTO ${rawLaunchV2Table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`cov-v2-${v2.token}`, chainId, v2.token, v2.poolAddress, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', zeroAddress,
        100, `0x${'a7'.repeat(32)}`, v2.txHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 500n, limit: 10, tables });
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-lifecycle', lane: 'history', fence: 500n, limit: 10, tables });
    // v2-curve/v2-buyback have no fixture raw table in this file — a real cycle (runIncrementalCycle)
    // always claims and advances every stream's cursor together, so stand that in for directly
    // rather than widening this file's fixture setup just for these two empty streams.
    for (const stream of ['v2-curve', 'v2-buyback'] as const) {
      await resetCursor(stream, 'history');
      const cursor = await claimSyncCursor(db, { chainId, stream, lane: 'history' });
      await advanceSyncCursor(db, { chainId, stream, lane: 'history' }, cursor.position, 500n);
    }

    await syncSourceCoverage(db, chainId, 500n);

    for (const id of v1FactoryIds) {
      const [row] = await db.select().from(sources).where(eq(sources.id, id));
      expect(row!.confirmedToBlock).toBe(500n);
      expect(row!.status).toBe('caught_up');
    }
    for (const id of [v2Factory.id, 'pons-v2-curve', 'pons-v2-lifecycle']) {
      const [row] = await db.select().from(sources).where(eq(sources.id, id));
      expect(row!.confirmedToBlock).toBe(500n);
      expect(row!.status).toBe('caught_up');
    }
  });

  it('never regresses confirmed_to_block below a value already recorded (final review, Critical 3)', async () => {
    await resetCursor('v2-launch', 'history');
    await seedSource(v2Factory.id);
    await db.update(sources).set({ confirmedToBlock: 900n, scannedToBlock: 900n, status: 'caught_up' }).where(eq(sources.id, v2Factory.id));

    // This cycle's own history-lane watermark is far behind 900 (a fresh resetCursor + tiny fence) —
    // syncSourceCoverage must not drag a previously-advanced source backward.
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 50n, limit: 10, tables });
    await syncSourceCoverage(db, chainId, 900n);

    const [row] = await db.select().from(sources).where(eq(sources.id, v2Factory.id));
    expect(row!.confirmedToBlock).toBe(900n);
    expect(row!.status).toBe('caught_up');
  });
});

describe('repriceNullPricedTrades (final review, Critical 2)', () => {
  it('fills in a previously null-priced V1 trade once the launch\'s token decimals are resolved later — never left null forever', async () => {
    await resetCursor('v1-launch', 'history');
    await resetCursor('v1-swap', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`reprice-${token}`, token, poolAddress, txHash, 100, 1);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 500n, limit: 10, tables });
    await insertSwapRow(`reprice-swap-${token}`, poolAddress, 110, 1, '100000000000000000', '-200000000000000000000');
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-swap', lane: 'history', fence: 500n, limit: 10, tables });

    let [tradeRow] = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRow!.priceNumeratorRaw).toBeNull();
    expect(tradeRow!.priceDenominatorRaw).toBeNull();

    // Core metadata enrichment resolves the token's decimals later — on-chain truth was always
    // available, this trade's price must not stay null forever just because it arrived first.
    await db.update(launches).set({ tokenDecimals: 18 }).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
    const launch = await lookupLaunch(db, chainId, token);
    const repricedCount = await repriceNullPricedTrades(envioPool, db, launch!, tables);
    expect(repricedCount).toBe(1);

    [tradeRow] = await db.select().from(trades).where(eq(trades.tokenAddress, token));
    expect(tradeRow!.priceNumeratorRaw).not.toBeNull();
    expect(tradeRow!.priceDenominatorRaw).not.toBeNull();
    expect(BigInt(tradeRow!.priceNumeratorRaw!)).toBeGreaterThan(0n);
    expect(BigInt(tradeRow!.priceDenominatorRaw!)).toBeGreaterThan(0n);

    // Idempotent: re-running after the trade is already priced reprices nothing.
    const secondPass = await repriceNullPricedTrades(envioPool, db, launch!, tables);
    expect(secondPass).toBe(0);
  });

  it('never touches a curve/buyback trade, which is null by design regardless of decimals', async () => {
    await resetCursor('v2-launch', 'history');
    const { token, poolAddress: curveAddress, txHash: launchTxHash } = freshToken();
    await envioPool.query(`INSERT INTO ${rawLaunchV2Table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`reprice-v2-${token}`, chainId, token, curveAddress, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', zeroAddress,
        100, `0x${'a7'.repeat(32)}`, launchTxHash, 1]);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v2-launch', lane: 'history', fence: 500n, limit: 10, tables });
    const launch = await lookupLaunch(db, chainId, token);
    await db.insert(venues).values({
      id: `curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curveAddress,
      sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: 100n, official: true,
    });
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: `curve-${token}`, blockNumber: 105n, blockHash: `0x${'e1'.repeat(32)}`,
      txHash: `0x${'e2'.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_100, side: 'buy',
      tokenAmountRaw: '1000000000000000000', quoteAmountRaw: '2000000000000000000',
      quoteAssetAddress: zeroAddress, sourceEvent: 'CurveBuy', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: zeroAddress,
    });

    const repricedCount = await repriceNullPricedTrades(envioPool, db, launch!, tables);
    expect(repricedCount).toBe(0);
    const [tradeRow] = await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    expect(tradeRow!.priceNumeratorRaw).toBeNull();
  });
});
