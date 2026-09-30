import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { syncV1LegacyOnce } from './runSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
// A second, throwaway Postgres schema on the SAME test database stands in for Envio's own Postgres —
// this test only needs rows shaped like Envio's real raw tables (confirmed empirically in Task 1
// Step 7 / Task 2 Step 7), not an actual running Envio stack.
const envioPool = new Pool({ connectionString: databaseUrl });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawLaunch" (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture."RawSwap" (
    id text primary key, "chainId" int, "poolAddress" text, sender text, recipient text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
});

beforeEach(async () => {
  await pool.query('TRUNCATE launches_envio_staging, venues_envio_staging, trades_envio_staging');
  await envioPool.query('TRUNCATE envio_fixture."RawLaunch", envio_fixture."RawSwap"');
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture CASCADE');
  await pool.end();
  await envioPool.end();
});

describe('syncV1LegacyOnce', () => {
  it('writes one launch and one trade from matching raw rows, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture."RawLaunch" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l1', 4663, '0x39dbed3a2bd333467115de45665cc57f813c4571', '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
        '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '8963150', '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8', 45],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture."RawSwap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      ['s1', 4663, '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '0xcaf681a66d020601342297493863e78c959e5cb2', '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a',
        '100000000000000000', '-68057245261861571047346184', '2005366647941715384651103712059394',
        '36819258015569838458222', 202790, '8963150',
        '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8', 49, 1_700_000_000],
    );

    const first = await syncV1LegacyOnce(envioPool, db);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    const launchRows = await db.select().from(launchesEnvioStaging);
    expect(launchRows).toHaveLength(1);
    expect(launchRows[0].tokenAddress).toBe('0x39dbed3a2bd333467115de45665cc57f813c4571');
    const tradeRows = await db.select().from(tradesEnvioStaging);
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0].side).toBe('buy');

    const second = await syncV1LegacyOnce(envioPool, db);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0 });
    expect(await db.select().from(launchesEnvioStaging)).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging)).toHaveLength(1);
  });
});
