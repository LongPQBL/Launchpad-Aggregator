import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq, and } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioSyncCursors, launches, venues, trades, sources, rawLogs } from '../db/schema.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { STREAMS, claimSyncCursor, advanceSyncCursor } from './incrementalCursor.js';
import { applyEnvioPage } from './incrementalSync.js';
import { repairEnvioWindow } from './incrementalRepair.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

const envioPool = new Pool({ connectionString: databaseUrl });
const rawLaunchTable = 'envio_fixture_repair."RawLaunch"';
const chainId = 4663;
const legacyFactory = getPonsFactorySources().find((factory) => factory.id === 'pons-v1-legacy')!.factory;
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
// repairEnvioWindow compares every stream in one pass — the other 7 streams only need an empty,
// safely-queryable fixture table so their own (unrelated) diff finds nothing.
const tables = Object.fromEntries(STREAMS.map((stream) => [stream, `envio_fixture_repair."${stream.replace(/-/g, '_')}"`])) as Record<typeof STREAMS[number], string>;
tables['v1-launch'] = rawLaunchTable;
const fence = 1000n;
const depth = 500n; // windowStart = 500
const legacyRawLogId = 'repair-test-legacy-raw-log';

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_repair');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawLaunchTable} (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "factoryAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  for (const stream of STREAMS) {
    if (stream === 'v1-launch') continue;
    await envioPool.query(`CREATE TABLE IF NOT EXISTS ${tables[stream]} (
      id text primary key, "chainId" int, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  }
  await db.insert(sources).values([
    { id: 'pons-v1-legacy', chainId, version: 'v1', factoryAddress: legacyFactory, startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' },
    { id: 'pons-v1-legacy-trades', chainId, version: 'v1', factoryAddress: legacyFactory, startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' },
  ]).onConflictDoNothing();
  await db.insert(rawLogs).values({
    id: legacyRawLogId, chainId, sourceId: 'pons-v1-legacy', blockNumber: 1n, blockHash: `0x${'0'.repeat(64)}`,
    txHash: `0x${'0'.repeat(64)}`, logIndex: 0, address: legacyFactory, topics: [], data: '0x',
  }).onConflictDoNothing();
});

const testTokens: string[] = [];
let nextSuffix = 0;
function freshToken(): { token: string; poolAddress: string; txHash: string } {
  nextSuffix += 1;
  const n = nextSuffix.toString(16).padStart(4, '0');
  const token = `0x11${n}000000000000000000000000000000000001`;
  const poolAddress = `0x21${n}000000000000000000000000000000000001`;
  const txHash = `0x31${n}000000000000000000000000000000000000000000000000000000000001`;
  testTokens.push(token);
  return { token, poolAddress, txHash };
}
async function insertLaunchRow(id: string, token: string, poolAddress: string, txHash: string, blockNumber: number, blockHash: string): Promise<void> {
  await envioPool.query(`INSERT INTO ${rawLaunchTable} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET "blockHash" = $9`,
    [id, chainId, token, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', weth, poolAddress, legacyFactory, blockNumber, blockHash, txHash, 1]);
}
async function resetCursor(stream: 'v1-launch', lane: 'tail' | 'history'): Promise<void> {
  await db.delete(envioSyncCursors).where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, stream), eq(envioSyncCursors.lane, lane)));
}

beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${rawLaunchTable}`);
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture_repair CASCADE');
  for (const token of testTokens) {
    await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    await db.delete(venues).where(and(eq(venues.chainId, chainId), eq(venues.tokenAddress, token)));
    await db.delete(launches).where(and(eq(launches.chainId, chainId), eq(launches.tokenAddress, token)));
  }
  await db.delete(envioSyncCursors).where(eq(envioSyncCursors.chainId, chainId));
  await pool.end();
  await envioPool.end();
});

describe('repairEnvioWindow: same-block replacement', () => {
  it('deletes a launch whose block hash no longer matches Envio and rewinds the cursor so the replacement is re-applied', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    const oldHash = `0x${'a1'.repeat(32)}`;
    const newHash = `0x${'b2'.repeat(32)}`;
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, oldHash);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables });
    const [before] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(before).toBeDefined();

    // A reorg replaced block 600 — Envio now reports a different blockHash for the same tx/log position.
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, newHash);
    const report = await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });
    expect(report.changedLaunchKeys).toContainEqual({ chainId, tokenAddress: token });
    expect(await db.select().from(launches).where(eq(launches.tokenAddress, token))).toHaveLength(0);

    const reapplied = await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables });
    expect(reapplied.applied).toBe(1);
    const [after] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(after.launchBlockHash).toBe(newHash);
  });
});

describe('repairEnvioWindow: deletion without replacement', () => {
  it('removes a launch whose raw event is no longer present in Envio at all', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, `0x${'c3'.repeat(32)}`);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables });
    expect(await db.select().from(launches).where(eq(launches.tokenAddress, token))).toHaveLength(1);

    await envioPool.query(`DELETE FROM ${rawLaunchTable} WHERE id = $1`, [`launch-${token}`]);
    const report = await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });
    expect(report.changedLaunchKeys).toContainEqual({ chainId, tokenAddress: token });
    expect(await db.select().from(launches).where(eq(launches.tokenAddress, token))).toHaveLength(0);
  });
});

describe('repairEnvioWindow: surviving launch metadata', () => {
  it('leaves a launch untouched, including its enriched metadata, when its key still matches Envio', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    const blockHash = `0x${'d4'.repeat(32)}`;
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, blockHash);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables });
    await db.update(launches).set({ name: 'Enriched Name', symbol: 'ENR', tokenDecimals: 9 }).where(eq(launches.tokenAddress, token));

    const report = await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });
    expect(report.changedLaunchKeys).not.toContainEqual({ chainId, tokenAddress: token });
    const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(row.name).toBe('Enriched Name');
    expect(row.tokenDecimals).toBe(9);
  });
});

describe('repairEnvioWindow: legacy source_log_id rows', () => {
  it('never touches a launch imported by the old RPC-scan indexer, even with no matching Envio row', async () => {
    const { token } = freshToken();
    await db.insert(launches).values({
      chainId, tokenAddress: token, sourceId: 'pons-v1-legacy', sourceLogId: legacyRawLogId,
      name: 'Legacy Launch', symbol: 'LEG', tokenDecimals: 18, platform: 'pons', protocolVersion: 'v1',
      factoryAddress: legacyFactory, deployerAddress: token, launchBlock: 600n, launchBlockHash: `0x${'e5'.repeat(32)}`,
      launchTxHash: `0x${'e5'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH',
      quoteAssetDecimals: 18, lifecycleStatus: 'trading', coreMetadataReadState: 'done',
    });

    await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });
    const rows = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Legacy Launch');
  });
});

describe('repairEnvioWindow: curve and buyback trades are not cross-deleted (final review, Important 6)', () => {
  it('leaves a matching curve trade and a matching buyback trade both in place — each diffed against its own raw table, not the shared venue kind', async () => {
    const { token, poolAddress: curveAddress } = freshToken();
    // sourceLogId non-null (an "old indexer" row, by this file's own convention) so repair's
    // launch-window diff for v1-launch/v2-launch never touches it — this test is isolating the
    // curve/buyback trade-diffing step, not launch repair.
    await db.insert(launches).values({
      chainId, tokenAddress: token, sourceId: 'pons-v1-legacy', sourceLogId: legacyRawLogId,
      name: null, symbol: null, tokenDecimals: null, platform: 'pons', protocolVersion: 'v2',
      factoryAddress: curveAddress, deployerAddress: token, launchBlock: 500n, launchBlockHash: `0x${'aa'.repeat(32)}`,
      launchTxHash: `0x${'aa'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH',
      quoteAssetDecimals: 18, lifecycleStatus: 'trading', coreMetadataReadState: 'done',
    });
    await db.insert(venues).values({
      id: `curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curveAddress,
      sourceId: 'pons-v2-curve', sourceLogId: null, effectiveFromBlock: 500n, official: true,
    });
    const curveBlockHash = `0x${'c6'.repeat(32)}`;
    const curveTxHash = `0x${'c7'.repeat(32)}`;
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: `curve-${token}`, blockNumber: 600n, blockHash: curveBlockHash,
      txHash: curveTxHash, logIndex: 1, timestamp: 1_700_000_000, side: 'buy',
      tokenAmountRaw: '1000000000000000000', quoteAmountRaw: '2000000000000000000',
      quoteAssetAddress: weth, sourceEvent: 'CurveBuy', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
    await envioPool.query(`INSERT INTO ${tables['v2-curve']} VALUES ($1,$2,$3,$4,$5,$6)`,
      ['curve-raw-1', chainId, 600, curveBlockHash, curveTxHash, 1]);

    const buybackBlockHash = `0x${'b8'.repeat(32)}`;
    const buybackTxHash = `0x${'b9'.repeat(32)}`;
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: `curve-${token}`, blockNumber: 610n, blockHash: buybackBlockHash,
      txHash: buybackTxHash, logIndex: 1, timestamp: 1_700_000_100, side: 'buy',
      tokenAmountRaw: '500000000000000000', quoteAmountRaw: '700000000000000000',
      quoteAssetAddress: weth, sourceEvent: 'BuybackLocked', activityKind: 'protocol_buyback',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
    await envioPool.query(`INSERT INTO ${tables['v2-buyback']} VALUES ($1,$2,$3,$4,$5,$6)`,
      ['buyback-raw-1', chainId, 610, buybackBlockHash, buybackTxHash, 1]);

    await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });

    const remaining = await db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
    expect(remaining.map((row) => row.sourceEvent).sort()).toEqual(['BuybackLocked', 'CurveBuy']);
  });
});

describe('repairEnvioWindow: a launch deletion forces its dependent streams\' cursors to rewind too (final review, Important 7)', () => {
  it('rewinds the swap stream even when the swap row itself was already gone via the launch\'s cascade delete, so it is re-applied rather than lost', async () => {
    await resetCursor('v1-launch', 'history');
    const v1SwapKey = { chainId, stream: 'v1-swap' as const, lane: 'history' as const };
    await db.delete(envioSyncCursors).where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, v1SwapKey.stream), eq(envioSyncCursors.lane, v1SwapKey.lane)));
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, `0x${'a1'.repeat(32)}`);
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence, limit: 10, tables });
    const [launchRow] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
    await db.insert(venues).values({
      id: `v3-${token}`, chainId, tokenAddress: token, kind: 'v3_pool', ref: poolAddress,
      sourceId: `${launchRow!.sourceId}-trades`, sourceLogId: null, effectiveFromBlock: 600n, official: true,
    });
    await db.insert(trades).values({
      chainId, tokenAddress: token, venueId: `v3-${token}`, blockNumber: 610n, blockHash: `0x${'a2'.repeat(32)}`,
      txHash: `0x${'a3'.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_000, side: 'buy',
      tokenAmountRaw: '1000000000000000000', quoteAmountRaw: '2000000000000000000',
      quoteAssetAddress: weth, sourceEvent: 'Swap', activityKind: 'user_trade',
      priceNumeratorRaw: null, priceDenominatorRaw: null, traderAddress: token,
    });
    // v1-swap's own cursor already read well past this window with nothing stale of its own —
    // simulates a prior pass that read this trade before the launch itself became stale.
    await claimSyncCursor(db, v1SwapKey);
    await advanceSyncCursor(db, v1SwapKey, { blockNumber: 900n, logIndex: 0, rawId: 'x' }, 900n);

    // The launch itself now goes stale (Envio no longer reports it) — its delete cascades to the
    // venue and trade above, so the v1-swap step's own diff finds nothing of its own to flag.
    await envioPool.query(`DELETE FROM ${rawLaunchTable} WHERE id = $1`, [`launch-${token}`]);
    await repairEnvioWindow(envioPool, db, { chainId, fence, depth, tables });

    const afterSwapCursor = (await db.select().from(envioSyncCursors).where(and(
      eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, 'v1-swap'), eq(envioSyncCursors.lane, 'history'),
    )))[0]!;
    // Must be rewound to windowStart (500) like the launch's own stream — a future swap for a
    // relaunched/corrected token in this window must be re-read, not silently skipped forever.
    expect(afterSwapCursor.blockNumber).toBeLessThanOrEqual(500n);
  });
});

describe('repairEnvioWindow: Envio processed-block rollback behind the cursor', () => {
  it('rewinds a stream\'s cursor whose recorded watermark is now ahead of the observed Envio fence', async () => {
    await resetCursor('v1-launch', 'history');
    const { token, poolAddress, txHash } = freshToken();
    await insertLaunchRow(`launch-${token}`, token, poolAddress, txHash, 600, `0x${'f6'.repeat(32)}`);
    // Advance the cursor's watermark well past the fence this repair call will use.
    await applyEnvioPage(envioPool, db, { chainId, stream: 'v1-launch', lane: 'history', fence: 900n, limit: 10, tables });
    const beforeCursor = (await db.select().from(envioSyncCursors)
      .where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, 'v1-launch'), eq(envioSyncCursors.lane, 'history'))))[0]!;
    expect(beforeCursor.processedWatermark).toBe(900n);

    // Envio's own observed fence has since rolled back below the cursor's recorded watermark.
    const rolledBackFence = 700n;
    await repairEnvioWindow(envioPool, db, { chainId, fence: rolledBackFence, depth, tables });
    const afterCursor = (await db.select().from(envioSyncCursors)
      .where(and(eq(envioSyncCursors.chainId, chainId), eq(envioSyncCursors.stream, 'v1-launch'), eq(envioSyncCursors.lane, 'history'))))[0]!;
    expect(afterCursor.blockNumber).toBeLessThanOrEqual(rolledBackFence - depth);
    expect(afterCursor.processedWatermark).toBeLessThanOrEqual(rolledBackFence);
  });
});
