import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { createDatabase } from '../db/client.js';
import { venuesEnvioStaging, tradesEnvioStaging } from '../db/schema.js';
import { derivePonsV4PoolId } from '../launchpads/pons/v2/poolKey.js';
import type { Launch } from '../domain/types.js';
import { syncV4Once } from './runSyncV4.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');

const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: databaseUrl });
const fixtureTables = {
  rawV4InitializeTable: 'envio_fixture_v4."RawV4Initialize"',
  rawV4SwapTable: 'envio_fixture_v4."RawV4Swap"',
};
// Deliberately synthetic, distinct from the real pons-v2-graduated.json fixture's token/curve
// addresses that runSync.integration.test.ts and runSyncV2.integration.test.ts also use — Vitest
// runs integration test files in parallel, and those files' beforeAll/afterAll DELETE+INSERT cycles
// for the real fixture token would otherwise race with this file's own cycles for the exact same
// row (found live: this test failed intermittently with venuesOpened:0 until this change — the
// real fixture token's lifecycle_transitions_envio_staging/venues_envio_staging rows were being
// deleted out from under this test by the other file's concurrent cleanup).
const testToken = '0x4444444444444444444444444444444444444444' as Address;
const testQuote = '0x5555555555555555555555555555555555555555' as Address;
const testCurve = '0x6666666666666666666666666666666666666666';
const testHook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address; // the real, audited Pons hook — must stay real, verifyV4PoolFromEnvio checks against it
const testSwapTxHash = '0x' + 'a'.repeat(64);
const testGraduationTxHash = '0x' + 'b'.repeat(64);
const testGraduationBlockHash = '0x' + 'c'.repeat(64);

const syntheticLaunch: Launch = {
  chainId: 4663, tokenAddress: testToken, name: '', symbol: '', tokenDecimals: 18,
  platform: 'pons', protocolVersion: 'v2', sourceId: 'pons-v2', sourceLogId: '',
  factoryAddress: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address, deployerAddress: '0xcce4f7805b3a5f03fe3ec7f02231d08b03cc35d2' as Address,
  launchBlock: 27823666n, launchTxHash: ('0x' + 'd'.repeat(64)) as `0x${string}`,
  quoteAsset: { address: testQuote, symbol: '', decimals: 18 }, lifecycleStatus: 'graduated',
};
// Derived, not hardcoded — this test's Initialize row must be internally self-consistent for
// verifyV4PoolFromEnvio to accept it, exactly like the real pipeline would require.
const testPoolId = derivePonsV4PoolId(syntheticLaunch, { fee: 0, tickSpacing: 200 }, testHook);

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
    `INSERT INTO launches_envio_staging (chain_id, token_address, name, symbol, token_decimals, platform, protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status) VALUES (4663,$1,null,null,18,'pons','v2',$2,$3,27823666,$4,$5,null,null,'graduated')`,
    [testToken, syntheticLaunch.factoryAddress, syntheticLaunch.deployerAddress, syntheticLaunch.launchTxHash, testQuote],
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
      ['i1', 4663, testPoolId, testToken, testQuote,
        0, 200, testHook, '35770440558388723973569516', -154068,
        '27828161', testGraduationBlockHash, testGraduationTxHash, 16],
    );
    await envioPool.query(
      `INSERT INTO envio_fixture_v4."RawV4Swap" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      ['s1', 4663, testPoolId, '0x9999999999999999999999999999999999999999', '0x9999999999999999999999999999999999999999',
        '-1000000000000000000', '500000000000000000', '30937564032784793309170036',
        '92140088551983424601325', -156971, 0,
        '27828165', '0x' + 'e'.repeat(64), testSwapTxHash, 108, 1_700_000_000],
    );

    const first = await syncV4Once(envioPool, db, fixtureTables);
    expect(first).toEqual({ venuesOpened: 1, tradesWritten: 1 });
    const venues = await db.select().from(venuesEnvioStaging).where(and(eq(venuesEnvioStaging.tokenAddress, testToken), eq(venuesEnvioStaging.kind, 'v4_pool')));
    expect(venues).toHaveLength(1);
    expect(venues[0].ref).toBe(testPoolId);
    const trades = await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testSwapTxHash));
    expect(trades).toHaveLength(1);

    const second = await syncV4Once(envioPool, db, fixtureTables);
    expect(second).toEqual({ venuesOpened: 0, tradesWritten: 0 });
  });
});
