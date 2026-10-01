import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging,
  launches, venues, trades, lifecycleTransitions, sources } from '../db/schema.js';
import { syncV2Once, syncV2ToReal } from './runSyncV2.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
// Uses its own envio-side schema name (not shared with runSync.integration.test.ts's
// envio_fixture_v1) and scopes every app-side staging-table read/write to this test's own
// token/tx — Vitest runs integration test files in parallel, and both files' tests touch the SAME
// shared launches_envio_staging/venues_envio_staging/trades_envio_staging tables (by design — those
// tables are shared in production too), so neither file may TRUNCATE them wholesale or assert on
// their whole-table length.
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawLaunchV2Table: 'envio_fixture_v2."RawLaunchV2"',
  rawCurveTradeTable: 'envio_fixture_v2."RawCurveTrade"',
  rawCurveBuybackTable: 'envio_fixture_v2."RawCurveBuyback"',
  rawLifecycleTable: 'envio_fixture_v2."RawLifecycleTransition"',
  progressTable: 'envio_fixture_v2.chain_metadata',
};
const testToken = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29';
const testTradeTxHash = '0x8147b8c06a405cd1d5314c16a25c86a0ba3aea64e490547e60afdbbff534cc28';
const testLifecycleTxHash = '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3';
const rpcCalls: string[] = [];
const rpcClient = { readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
  rpcCalls.push(`${address.toLowerCase()}:${functionName}`);
  if (address.toLowerCase() === testToken) {
    if (functionName === 'name') return 'Test V2';
    if (functionName === 'symbol') return 'TV2';
    if (functionName === 'decimals') return 18;
  }
  if (functionName === 'symbol') return 'NVDA';
  if (functionName === 'decimals') return 8;
  throw new Error(`unexpected ${functionName}`);
} };

beforeAll(async () => {
  // Migration runs once in vitest.integration.globalSetup.ts, before any test file's beforeAll.
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_v2');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v2."RawLaunchV2" (
    id text primary key, "chainId" int, "tokenAddress" text, "curveAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v2."RawCurveTrade" (
    id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v2."RawCurveBuyback" (
    id text primary key, "chainId" int, "curveAddress" text, "quoteSpentRaw" numeric, "tokensLockedRaw" numeric,
    "txFrom" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v2."RawLifecycleTransition" (
    id text primary key, "chainId" int, "tokenAddress" text, phase int, kind text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query('CREATE TABLE IF NOT EXISTS envio_fixture_v2.chain_metadata (chain_id int primary key, latest_processed_block bigint, block_height bigint)');
  await envioPool.query(`INSERT INTO envio_fixture_v2.chain_metadata VALUES (4663,27828165,90000000)
    ON CONFLICT (chain_id) DO UPDATE SET latest_processed_block=27828165,block_height=90000000`);
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testTradeTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await envioPool.query('TRUNCATE envio_fixture_v2."RawLaunchV2", envio_fixture_v2."RawCurveTrade", envio_fixture_v2."RawCurveBuyback", envio_fixture_v2."RawLifecycleTransition"');
});

afterAll(async () => {
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testTradeTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await envioPool.query('DROP SCHEMA envio_fixture_v2 CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('syncV2Once', () => {
  it('writes a launch, a curve trade, and a lifecycle transition, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture_v2."RawLaunchV2" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l2', 4663, testToken, '0x94fd7acd1830065468ce50179f1f18a053586139',
        '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2', '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
        '27823666', '0x7b69362e91d3247bf46d43fc07569b43abfbb219f31dcc0e897e13ff49762eba',
        '0xd7b79e93a733b14976e964215ecca560903ac4be818b48b08dabbef5e8b45ab6', 30],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v2."RawCurveTrade" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      ['t2', 4663, '0x94fd7acd1830065468ce50179f1f18a053586139', 'buy',
        '20552501950319369479600566', '352696917677647859', '3526969176776478', '0',
        '0x1234567890123456789012345678901234567890',
        '27823668', '0xbaa41185b64193502af49abb8f14b3a178042291804605300f358969d3a8fa2e',
        testTradeTxHash, 19, 1_700_000_000],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v2."RawLifecycleTransition" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ['g2', 4663, testToken, 2, 'graduated',
        '27828161', '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e',
        testLifecycleTxHash, 36],
    );

    const first = await syncV2Once(envioPool, db, fixtureTables, rpcClient);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
    const launchRows = await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, testToken));
    expect(launchRows).toHaveLength(1);
    expect(launchRows[0].name).toBe('Test V2');
    expect(launchRows[0].symbol).toBe('TV2');
    expect(launchRows[0].quoteAssetSymbol).toBe('NVDA');
    expect(launchRows[0].quoteAssetDecimals).toBe(8);
    expect(rpcCalls).toHaveLength(5);
    expect(rpcCalls.filter((call) => call.startsWith('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec:'))).toHaveLength(2);
    expect(await db.select().from(venuesEnvioStaging).where(eq(venuesEnvioStaging.tokenAddress, testToken))).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testTradeTxHash))).toHaveLength(1);
    const transitions = await db.select().from(lifecycleTransitionsEnvioStaging).where(eq(lifecycleTransitionsEnvioStaging.tokenAddress, testToken));
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe('graduated');

    const second = await syncV2Once(envioPool, db, fixtureTables, rpcClient);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0, transitionsWritten: 0 });
    expect(rpcCalls).toHaveLength(5);
    await envioPool.query('TRUNCATE envio_fixture_v2."RawLaunchV2", envio_fixture_v2."RawCurveTrade", envio_fixture_v2."RawCurveBuyback", envio_fixture_v2."RawLifecycleTransition"');
  });
});

describe('syncV2ToReal', () => {
  it('writes launch, curve trade and lifecycle into real tables and tracks Envio progress', async () => {
    const token = '0xedededededededededededededededededededed';
    const curve = '0xefefefefefefefefefefefefefefefefefefefef';
    const pair = '0x1212121212121212121212121212121212121212';
    const launchTx = '0x' + 'a'.repeat(64);
    const tradeTx = '0x' + 'b'.repeat(64);
    const transitionTx = '0x' + 'c'.repeat(64);
    const blockHash = '0x' + 'd'.repeat(64);
    for (const id of ['pons-v2', 'pons-v2-curve', 'pons-v2-lifecycle']) {
      await db.insert(sources).values({ id, chainId: 4663, version: 'v2', factoryAddress: token,
        startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
    }
    await envioPool.query(`INSERT INTO envio_fixture_v2."RawLaunchV2" VALUES ('real',4663,$1,$2,$1,$3,27823666,$4,$5,30)`,
      [token, curve, pair, blockHash, launchTx]);
    await envioPool.query(`INSERT INTO envio_fixture_v2."RawCurveTrade" VALUES ('real-trade',4663,$1,'buy',100,200,0,0,$2,27823668,$3,$4,19,1700000000)`,
      [curve, token, blockHash, tradeTx]);
    await envioPool.query(`INSERT INTO envio_fixture_v2."RawLifecycleTransition" VALUES ('real-grad',4663,$1,2,'graduated',27828161,$2,$3,36)`,
      [token, blockHash, transitionTx]);
    const calls: string[] = [];
    const client = { readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      calls.push(address.toLowerCase());
      if (address.toLowerCase() === token) {
        if (functionName === 'name') return 'Real V2';
        if (functionName === 'symbol') return 'RV2';
        if (functionName === 'decimals') return 18;
      }
      if (address.toLowerCase() === pair) {
        if (functionName === 'symbol') return 'USDG';
        if (functionName === 'decimals') return 6;
      }
      throw new Error(`${address} ${functionName}`);
    } };
    try {
      const first = await syncV2ToReal(envioPool, db, fixtureTables, client);
      expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
      const [launch] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(launch.name).toBe('Real V2');
      expect(launch.quoteAssetDecimals).toBe(6);
      expect(launch.lifecycleStatus).toBe('graduated');
      expect(launch.sourceLogId).toBeNull();
      expect(launch.launchLogIndex).toBe(30);
      const [venue] = await db.select().from(venues).where(eq(venues.tokenAddress, token));
      expect(venue.sourceId).toBe('pons-v2-curve');
      expect((await db.select().from(trades).where(eq(trades.txHash, tradeTx))).length).toBe(1);
      expect((await db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, transitionTx))).length).toBe(1);
      const [source] = await db.select().from(sources).where(eq(sources.id, 'pons-v2'));
      expect(source.confirmedToBlock).toBe(27828165n);
      expect(source.status).toBe('backfilling');
      expect(calls).toHaveLength(5);
      await syncV2ToReal(envioPool, db, fixtureTables, client);
      expect((await db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, transitionTx))).length).toBe(1);
      expect(calls).toHaveLength(5);
      await envioPool.query('DELETE FROM envio_fixture_v2."RawLifecycleTransition" WHERE id = $1', ['real-grad']);
      await syncV2ToReal(envioPool, db, fixtureTables, client);
      expect((await db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.txHash, transitionTx))).length).toBe(0);
      const [reverted] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(reverted.lifecycleStatus).toBe('trading');
    } finally {
      await db.delete(lifecycleTransitions).where(eq(lifecycleTransitions.tokenAddress, token));
      await db.delete(trades).where(eq(trades.tokenAddress, token));
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('TRUNCATE envio_fixture_v2."RawLaunchV2", envio_fixture_v2."RawCurveTrade", envio_fixture_v2."RawCurveBuyback", envio_fixture_v2."RawLifecycleTransition"');
    }
  });
});
