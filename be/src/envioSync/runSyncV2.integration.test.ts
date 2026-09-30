import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, venuesEnvioStaging, tradesEnvioStaging, lifecycleTransitionsEnvioStaging } from '../db/schema.js';
import { syncV2Once } from './runSyncV2.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawLaunchV2Table: 'envio_fixture."RawLaunchV2"',
  rawCurveTradeTable: 'envio_fixture."RawCurveTrade"',
  rawCurveBuybackTable: 'envio_fixture."RawCurveBuyback"',
  rawLifecycleTable: 'envio_fixture."RawLifecycleTransition"',
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLaunchV2" (
    id text primary key, "chainId" int, "tokenAddress" text, "curveAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawCurveTrade" (
    id text primary key, "chainId" int, "curveAddress" text, side text, "tokenAmountRaw" numeric,
    "quoteAmountRaw" numeric, "feeRaw" numeric, "taxRaw" numeric, "txFrom" text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawCurveBuyback" (
    id text primary key, "chainId" int, "curveAddress" text, "quoteSpentRaw" numeric, "tokensLockedRaw" numeric,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLifecycleTransition" (
    id text primary key, "chainId" int, "tokenAddress" text, phase int, kind text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
});

beforeEach(async () => {
  await pool.query('TRUNCATE launches_envio_staging, venues_envio_staging, trades_envio_staging, lifecycle_transitions_envio_staging');
  await envioPool.query('TRUNCATE envio_fixture."RawLaunchV2", envio_fixture."RawCurveTrade", envio_fixture."RawCurveBuyback", envio_fixture."RawLifecycleTransition"');
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('syncV2Once', () => {
  it('writes a launch, a curve trade, and a lifecycle transition, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLaunchV2" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l2', 4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', '0x94fd7acd1830065468ce50179f1f18a053586139',
        '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2', '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
        '27823666', '0x7b69362e91d3247bf46d43fc07569b43abfbb219f31dcc0e897e13ff49762eba',
        '0xd7b79e93a733b14976e964215ecca560903ac4be818b48b08dabbef5e8b45ab6', 30],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawCurveTrade" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      ['t2', 4663, '0x94fd7acd1830065468ce50179f1f18a053586139', 'buy',
        '20552501950319369479600566', '352696917677647859', '3526969176776478', '0',
        '0x1234567890123456789012345678901234567890',
        '27823668', '0xbaa41185b64193502af49abb8f14b3a178042291804605300f358969d3a8fa2e',
        '0x8147b8c06a405cd1d5314c16a25c86a0ba3aea64e490547e60afdbbff534cc28', 19, 1_700_000_000],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLifecycleTransition" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ['g2', 4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', 2, 'graduated',
        '27828161', '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e',
        '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3', 36],
    );

    const first = await syncV2Once(envioPool, db, fixtureTables);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1, transitionsWritten: 1 });
    expect(await db.select().from(launchesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(venuesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging)).toHaveLength(1);
    const transitions = await db.select().from(lifecycleTransitionsEnvioStaging);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe('graduated');

    const second = await syncV2Once(envioPool, db, fixtureTables);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0, transitionsWritten: 0 });
  });
});
