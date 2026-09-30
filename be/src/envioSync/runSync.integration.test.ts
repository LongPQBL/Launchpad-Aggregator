import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { syncV1LegacyOnce } from './runSync.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
// A second, throwaway Postgres schema on the SAME test database stands in for Envio's own Postgres —
// this test only needs rows shaped like Envio's real raw tables (confirmed empirically in Task 1
// Step 7 / Task 2 Step 7), not an actual running Envio stack. syncV1LegacyOnce's real production
// default points at envio."RawLaunch"/envio."RawSwap" (DEFAULT_ENVIO_TABLES) — this test explicitly
// overrides to this fixture schema instead, so a misconfigured deployment fails loudly rather than
// silently reading the fixture schema in production.
// Uses its own schema name (not shared with runSyncV2.integration.test.ts's envio_fixture_v2) —
// Vitest runs integration test files in parallel, and both files' tests touch the SAME shared
// launches_envio_staging/venues_envio_staging/trades_envio_staging tables (by design — those tables
// are shared in production too), so this file must never TRUNCATE them wholesale or assert on their
// whole-table length, only on its own token/tx's specific rows.
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = { rawLaunchTable: 'envio_fixture_v1."RawLaunch"', rawSwapTable: 'envio_fixture_v1."RawSwap"' };
const testToken = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const testTxHash = '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8';

beforeAll(async () => {
  // Migration runs once in vitest.integration.globalSetup.ts, before any test file's beforeAll.
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_v1');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v1."RawLaunch" (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v1."RawSwap" (
    id text primary key, "chainId" int, "poolAddress" text, sender text, recipient text, "txFrom" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  // Scoped to this test's own keys only — never a blanket TRUNCATE of the shared staging tables,
  // which runSyncV2.integration.test.ts's concurrently-running test also writes to.
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await envioPool.query('TRUNCATE envio_fixture_v1."RawLaunch", envio_fixture_v1."RawSwap"');
});

afterAll(async () => {
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await envioPool.query('DROP SCHEMA envio_fixture_v1 CASCADE');
  await pool.end();
  await envioPool.end();
});

// A distinct, made-up EOA — deliberately NOT equal to the Swap event's own `sender` param below, so
// the test can tell whether runSync used the real tx-from (correct) or the event's sender (the bug
// fixed after the final-review finding: routers appear as `sender`, not the actual trader).
const txFromTrader = '0x1234567890123456789012345678901234567890';

describe('syncV1LegacyOnce', () => {
  it('writes one launch and one trade from matching raw rows, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['l1', 4663, testToken, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
        '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '8963150', '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        testTxHash, 45],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v1."RawSwap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      ['s1', 4663, '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        '0xcaf681a66d020601342297493863e78c959e5cb2', '0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a', txFromTrader,
        '100000000000000000', '-68057245261861571047346184', '2005366647941715384651103712059394',
        '36819258015569838458222', 202790, '8963150',
        '0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3',
        testTxHash, 49, 1_700_000_000],
    );

    const first = await syncV1LegacyOnce(envioPool, db, fixtureTables);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    const launchRows = await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, testToken));
    expect(launchRows).toHaveLength(1);
    expect(launchRows[0].tokenAddress).toBe(testToken);
    // Metadata that Phase 1 has no RPC call to source is null, not a made-up placeholder — see
    // schema.ts's comment on launchesEnvioStaging and runSync.ts's on the hydrateV1Launch call.
    expect(launchRows[0].name).toBeNull();
    expect(launchRows[0].symbol).toBeNull();
    expect(launchRows[0].lifecycleStatus).toBeNull();
    const tradeRows = await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testTxHash));
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0].side).toBe('buy');
    expect(tradeRows[0].blockHash).toBe('0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3');
    // The trader is the tx-from column, not the Swap event's `sender` (a router address) — pins the
    // fix for the final-review finding described above.
    expect(tradeRows[0].traderAddress).toBe(txFromTrader);

    const second = await syncV1LegacyOnce(envioPool, db, fixtureTables);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0 });
    expect(await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, testToken))).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testTxHash))).toHaveLength(1);
  });
});
