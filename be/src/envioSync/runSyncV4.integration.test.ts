import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { syncV4Once } from './runSyncV4.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawV4InitializeTable: 'envio_fixture_v4."RawV4Initialize"',
  rawV4SwapTable: 'envio_fixture_v4."RawV4Swap"',
};
const testToken = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29';
const testCurve = '0x94fd7acd1830065468ce50179f1f18a053586139';
const testSwapTxHash = '0x9f9e677944d822a0f5f46307b098b0b1c593751492b25a7f5c6a02483ad40977';
const testGraduationTxHash = '0x98dfda1126a8b6b66a249db891a221f6fcebd2d17b6e57e2f0c119dba09ad6a3';
const testGraduationBlockHash = '0xa75d3da85a5aecb9a88e4dbac35a81a9d703255cec996cef677fb172992c3d0e';
const testPoolId = '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1';

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_v4');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v4."RawV4Initialize" (
    id text primary key, "chainId" int, "poolId" text, currency0 text, currency1 text,
    fee int, "tickSpacing" int, hooks text, "sqrtPriceX96" numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v4."RawV4Swap" (
    id text primary key, "chainId" int, "poolId" text, sender text, "txFrom" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int, fee int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  // Pre-seed the launch/curve-venue/graduated-transition rows this sync depends on — in production
  // these come from syncV1LegacyOnce/syncV2Once running first; this test seeds them directly to stay
  // focused on syncV4Once's own behavior.
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testSwapTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query(
    `INSERT INTO launches_envio_staging (chain_id, token_address, name, symbol, token_decimals, platform, protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status) VALUES (4663,$1,null,null,18,'pons','v2','0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e','0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2',27823666,$2,'0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',null,null,'graduated')`,
    [testToken, '0xd7b79e93a733b14976e964215ecca560903ac4be818b48b08dabbef5e8b45ab6'],
  );
  await pool.query(
    `INSERT INTO venues_envio_staging (id, chain_id, token_address, kind, ref, effective_from_block, official) VALUES ($1,4663,$2,'curve',$3,27823666,true)`,
    [`4663:curve:${testCurve}`, testToken, testCurve],
  );
  await pool.query(
    `INSERT INTO lifecycle_transitions_envio_staging (source_log_id, chain_id, token_address, phase, kind, block_number, block_hash, tx_hash, log_index) VALUES ($1,4663,$2,2,'graduated',27828161,$3,$4,36)`,
    [`4663:${testGraduationBlockHash}:${testGraduationTxHash}:36`, testToken, testGraduationBlockHash, testGraduationTxHash],
  );
});

afterAll(async () => {
  await envioPool.query('DROP SCHEMA envio_fixture_v4 CASCADE');
  await pool.query('DELETE FROM trades_envio_staging WHERE tx_hash = $1', [testSwapTxHash]);
  await pool.query('DELETE FROM venues_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM lifecycle_transitions_envio_staging WHERE token_address = $1', [testToken]);
  await pool.query('DELETE FROM launches_envio_staging WHERE token_address = $1', [testToken]);
  await pool.end();
  await envioPool.end();
});

describe('syncV4Once', () => {
  it('opens the verified V4 venue and syncs its swap, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture_v4."RawV4Initialize" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      ['i1', 4663, testPoolId, testToken, '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
        0, 200, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', '35770440558388723973569516', -154068,
        '27828161', testGraduationBlockHash, testGraduationTxHash, 16],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v4."RawV4Swap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      ['s1', 4663, testPoolId, '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc', '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
        '-31880381102749799957318148', '5620497268881825819', '30937564032784793309170036',
        '92140088551983424601325', -156971, 0,
        '27828165', '0x022e46946bdf2c013c477965de3211a1cb720fd3af32399301083572cb2d983b', testSwapTxHash, 108, 1_700_000_000],
    );

    const first = await syncV4Once(envioPool, db, fixtureTables);
    expect(first).toEqual({ venuesOpened: 1, tradesWritten: 1 });
    const venues = await db.select().from(venuesEnvioStaging).where(and(eq(venuesEnvioStaging.tokenAddress, testToken), eq(venuesEnvioStaging.kind, 'v4_pool')));
    expect(venues).toHaveLength(1);
    expect(venues[0].ref).toBe(testPoolId);
    const trades = await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testSwapTxHash));
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('sell');

    const second = await syncV4Once(envioPool, db, fixtureTables);
    expect(second).toEqual({ venuesOpened: 0, tradesWritten: 0 });
  });
});
