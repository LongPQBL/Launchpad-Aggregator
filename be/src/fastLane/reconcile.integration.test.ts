import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { fastLaneRows, launches, trades, venues } from '../db/schema.js';
import { applyLiveRows } from '../envioSync/incrementalSync.js';
import { recordFastRows } from './store.js';
import { reconcileLaneRows } from './reconcile.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const chainId = 4663; // applyRow hydrates against the Pons sources, which are chain 4663
const source = 'fast-lane-reconcile-test';
const token = '0x7a00000000000000000000000000000000000001';
const curve = '0x7a000000000000000000000000000000000000c1';
const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const table = 'envio_fixture_reconcile."RawCurveTrade"';
const tables = { 'v2-curve': table };
const laneHash = `0x${'b1'.repeat(32)}`;
const otherHash = `0x${'b2'.repeat(32)}`;

const raw = (suffix: string, overrides: Record<string, unknown> = {}) => ({
  id: `${chainId}-${laneHash}-${suffix}-1`, chainId, curveAddress: curve, side: 'buy', tokenAmountRaw: '1000', quoteAmountRaw: '2000',
  feeRaw: '0', taxRaw: '0', txFrom: '0x1111111111111111111111111111111111111111', blockNumber: '900', blockHash: laneHash,
  txHash: `0x${suffix.repeat(32)}`, logIndex: 1, timestamp: 1_700_000_000, ...overrides,
});
type Raw = ReturnType<typeof raw>;

/** What the lane does for a log: write the trade and remember it; `ageSeconds` backdates the bookkeeping row. */
async function laneWrite(entry: Raw, ageSeconds = 600): Promise<void> {
  const result = await applyLiveRows(db, chainId, [{ stream: 'v2-curve', raw: entry }]);
  expect(result.applied).toBe(1);
  await recordFastRows(db, chainId, [{ stream: 'v2-curve', raw: entry }]);
  await db.update(fastLaneRows).set({ writtenAt: new Date(Date.now() - ageSeconds * 1000) })
    .where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, entry.txHash)));
}
async function envioRow(entry: Raw): Promise<void> {
  await envioPool.query(`INSERT INTO ${table} (id, "chainId", "curveAddress", side, "tokenAmountRaw", "quoteAmountRaw", "feeRaw", "taxRaw", "txFrom",
    "blockNumber", "blockHash", "txHash", "logIndex", "timestamp") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [entry.id, entry.chainId, entry.curveAddress, entry.side, entry.tokenAmountRaw, entry.quoteAmountRaw, entry.feeRaw, entry.taxRaw, entry.txFrom,
    entry.blockNumber, entry.blockHash, entry.txHash, entry.logIndex, entry.timestamp]);
}
const tradeOf = async (entry: Raw) => db.select().from(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, entry.txHash)));
const laneRowOf = async (entry: Raw) => db.select().from(fastLaneRows).where(and(eq(fastLaneRows.chainId, chainId), eq(fastLaneRows.txHash, entry.txHash)));
const options = { chainId, processedBlock: 1000n, olderThanSeconds: 120, tables };

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_reconcile');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 1, 1, 1, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, token]);
  await db.insert(launches).values({
    chainId, tokenAddress: token, sourceId: source, sourceLogId: null, name: 'Rec', symbol: 'REC', tokenDecimals: 18, platform: 'pons',
    protocolVersion: 'v2', factoryAddress: curve, deployerAddress: token, launchBlock: 100n, launchBlockHash: `0x${'aa'.repeat(32)}`,
    launchTxHash: `0x${'7a'.repeat(32)}`, launchLogIndex: 1, quoteAssetAddress: weth, quoteAssetSymbol: 'WETH', quoteAssetDecimals: 18,
    lifecycleStatus: 'trading', coreMetadataReadState: 'done',
  }).onConflictDoNothing();
  await db.insert(venues).values({
    id: `fast-lane-reconcile-curve-${token}`, chainId, tokenAddress: token, kind: 'curve', ref: curve, sourceId: source, sourceLogId: null,
    effectiveFromBlock: 100n, official: true,
  }).onConflictDoNothing();
});
beforeEach(async () => {
  await envioPool.query(`TRUNCATE ${table}`);
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
});
afterAll(async () => {
  await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.tokenAddress, token)));
  await db.delete(fastLaneRows).where(eq(fastLaneRows.chainId, chainId));
  await pool.query('DELETE FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM venues WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await envioPool.query('DROP SCHEMA envio_fixture_reconcile CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('reconcileLaneRows', () => {
  it('keeps a row Envio has with the same block hash, trade and bookkeeping both, for parity', async () => {
    const entry = raw('c1');
    await laneWrite(entry); await envioRow(entry);
    expect(await reconcileLaneRows(db, envioPool, options)).toMatchObject({ kept: 1, removed: 0 });
    expect(await tradeOf(entry)).toHaveLength(1);
    expect(await laneRowOf(entry)).toHaveLength(1);
  });

  it('replaces a trade Envio has in another block: deletes the lane copy, applies Envio row, drops the curve checkpoint', async () => {
    const entry = raw('c2');
    await laneWrite(entry); await envioRow({ ...entry, id: 'envio-c2', blockHash: otherHash, blockNumber: '901' });
    await pool.query(`INSERT INTO launch_curve_reserves (chain_id, token_address, quote_reserve_raw, token_reserve_raw, last_block_number, last_log_index, updated_at)
      VALUES ($1, $2, 1, 1, 900, 1, now())`, [chainId, token]);
    expect(await reconcileLaneRows(db, envioPool, options)).toMatchObject({ removed: 1, replaced: 1 });
    const rows = await tradeOf(entry);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ blockHash: otherHash, blockNumber: 901n });
    expect(await laneRowOf(entry)).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM launch_curve_reserves WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows).toHaveLength(0);
  });

  it('deletes a lane trade Envio does not have once Envio has processed its block', async () => {
    const entry = raw('c3');
    await laneWrite(entry);
    expect(await reconcileLaneRows(db, envioPool, options)).toMatchObject({ removed: 1, replaced: 0 });
    expect(await tradeOf(entry)).toHaveLength(0);
    expect(await laneRowOf(entry)).toHaveLength(0);
  });

  it('leaves a row above Envio processed block, and a row younger than the safety age', async () => {
    const above = raw('c4', { blockNumber: '1500' });
    const young = raw('c5');
    await laneWrite(above); await laneWrite(young, 5);
    expect(await reconcileLaneRows(db, envioPool, options)).toMatchObject({ pending: 2, removed: 0, kept: 0 });
    expect(await tradeOf(above)).toHaveLength(1);
    expect(await tradeOf(young)).toHaveLength(1);
    expect(await laneRowOf(above)).toHaveLength(1);
  });

  it('forgets the bookkeeping row when the lane trade is already gone, and never touches a trade the lane did not write', async () => {
    const gone = raw('c6');
    await laneWrite(gone);
    await db.delete(trades).where(and(eq(trades.chainId, chainId), eq(trades.txHash, gone.txHash))); // repair already removed it
    const notOurs = raw('c7');
    await applyLiveRows(db, chainId, [{ stream: 'v2-curve', raw: notOurs }]); // written by the Envio sync, not recorded by the lane
    expect(await reconcileLaneRows(db, envioPool, options)).toMatchObject({ forgotten: 1, removed: 0 });
    expect(await laneRowOf(gone)).toHaveLength(0);
    expect(await tradeOf(notOurs)).toHaveLength(1);
  });
});
