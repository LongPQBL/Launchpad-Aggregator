import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { ContractFunctionRevertedError, HttpRequestError } from 'viem';
import { createDatabase } from '../db/client.js';
import { launchesEnvioStaging, tradesEnvioStaging, launches, venues, trades, sources, rawLogs } from '../db/schema.js';
import { syncV1LegacyOnce, syncV1LegacyToReal } from './runSync.js';
import { ponsExtendedMetadataAbi } from '../launchpads/pons/extendedMetadata.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';

const legacyFactory = getPonsFactorySources().find((factory) => factory.id === 'pons-v1-legacy')!.factory;

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
const fixtureTables = { rawLaunchTable: 'envio_fixture_v1."RawLaunch"', rawSwapTable: 'envio_fixture_v1."RawSwap"',
  progressTable: 'envio_fixture_v1.chain_metadata' };
const testToken = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const testTxHash = '0x1f54f25fec2d963dcb338ecb8b46a6eb123198a5c7a746d34cb2dbe78d074af8';

beforeAll(async () => {
  // Migration runs once in vitest.integration.globalSetup.ts, before any test file's beforeAll.
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_v1');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v1."RawLaunch" (
    id text primary key, "chainId" int, "tokenAddress" text, "deployerAddress" text,
    "pairTokenAddress" text, "poolAddress" text, "factoryAddress" text, "blockNumber" numeric, "blockHash" text,
    "txHash" text, "logIndex" int)`);
  await envioPool.query(`CREATE TABLE IF NOT EXISTS envio_fixture_v1."RawSwap" (
    id text primary key, "chainId" int, "poolAddress" text, sender text, recipient text, "txFrom" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, liquidity numeric, tick int,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int)`);
  await envioPool.query('CREATE TABLE IF NOT EXISTS envio_fixture_v1.chain_metadata (chain_id int primary key, latest_processed_block bigint, block_height bigint)');
  await envioPool.query(`INSERT INTO envio_fixture_v1.chain_metadata VALUES (4663,8963150,9000000)
    ON CONFLICT (chain_id) DO UPDATE SET latest_processed_block=8963150,block_height=9000000`);
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
const rpcCalls: string[] = [];
const rpcClient = { readContract: async ({ functionName }: { functionName: string }) => {
  rpcCalls.push(functionName);
  if (functionName === 'name') return 'Test Token';
  if (functionName === 'symbol') return 'TEST';
  if (functionName === 'decimals') return 18;
  if (functionName === 'liquidityPool') return '0x10cc6bd38112cac182db90b6a71d8bb5939526ba';
  throw new Error(`unexpected functionName ${functionName}`);
} };

describe('syncV1LegacyOnce', () => {
  it('writes one launch and one trade from matching raw rows, and is idempotent on re-run', async () => {
    await envioPool.query(
      `INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      ['l1', 4663, testToken, '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0',
        '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        legacyFactory,
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

    const first = await syncV1LegacyOnce(envioPool, db, fixtureTables, rpcClient);
    expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1 });
    const launchRows = await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, testToken));
    expect(launchRows).toHaveLength(1);
    expect(launchRows[0].tokenAddress).toBe(testToken);
    // New rows get token metadata from RPC; reruns reuse the stored values.
    expect(launchRows[0].name).toBe('Test Token');
    expect(launchRows[0].symbol).toBe('TEST');
    expect(rpcCalls).toEqual(['name', 'symbol', 'decimals', 'liquidityPool']);
    expect(launchRows[0].lifecycleStatus).toBeNull();
    const tradeRows = await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testTxHash));
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0].side).toBe('buy');
    expect(tradeRows[0].blockHash).toBe('0xd18718d02fe1da449333e477bc588a41e59b1fd169a2b945a14fb17339d684a3');
    // The trader is the tx-from column, not the Swap event's `sender` (a router address) — pins the
    // fix for the final-review finding described above.
    expect(tradeRows[0].traderAddress).toBe(txFromTrader);

    const second = await syncV1LegacyOnce(envioPool, db, fixtureTables, rpcClient);
    expect(second).toEqual({ launchesWritten: 0, tradesWritten: 0 });
    expect(rpcCalls).toHaveLength(4);
    expect(await db.select().from(launchesEnvioStaging).where(eq(launchesEnvioStaging.tokenAddress, testToken))).toHaveLength(1);
    expect(await db.select().from(tradesEnvioStaging).where(eq(tradesEnvioStaging.txHash, testTxHash))).toHaveLength(1);
    await envioPool.query('DELETE FROM envio_fixture_v1."RawSwap" WHERE id = $1', ['s1']);
    await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['l1']);
  });
});

describe('syncV1LegacyToReal', () => {
  it('writes into real tables, retains a pre-existing RPC launch and uses Envio progress', async () => {
    const realToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const existingToken = '0xffffffffffffffffffffffffffffffffffffffff';
    const poolAddress = '0xabababababababababababababababababababab';
    const existingPool = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const launchTx = '0x' + 'a'.repeat(64);
    const existingTx = '0x' + 'b'.repeat(64);
    const swapTx = '0x' + 'c'.repeat(64);
    const blockHash = '0x' + 'd'.repeat(64);
    const sourceLogId = `4663:${blockHash}:${existingTx}:8`;
    for (const id of ['pons-v1-legacy', 'pons-v1-legacy-trades']) {
      await db.insert(sources).values({ id, chainId: 4663, version: 'v1', factoryAddress: realToken,
        startBlock: 1n, scannedToBlock: 1n, confirmedToBlock: 1n, status: 'backfilling' }).onConflictDoNothing();
    }
    await db.insert(rawLogs).values({ id: sourceLogId, chainId: 4663, sourceId: 'pons-v1-legacy',
      blockNumber: 8963150n, blockHash, txHash: existingTx, logIndex: 8, address: existingToken,
      topics: [], data: '0x' }).onConflictDoNothing();
    await db.insert(launches).values({ chainId: 4663, tokenAddress: existingToken, sourceId: 'pons-v1-legacy',
      sourceLogId, launchLogIndex: 8, name: 'Existing', symbol: 'OLD', tokenDecimals: 18,
      platform: 'pons', protocolVersion: 'v1', factoryAddress: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
      deployerAddress: existingToken, launchBlock: 8963150n, launchTxHash: existingTx,
      quoteAssetAddress: '0x4200000000000000000000000000000000000006', quoteAssetSymbol: 'WETH',
      quoteAssetDecimals: 18, lifecycleStatus: 'trading' }).onConflictDoNothing();
    const insertLaunch = async (id: string, token: string, poolAddress: string, txHash: string, logIndex: number) => {
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        [id, token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, txHash, logIndex]);
    };
    await insertLaunch('real', realToken, poolAddress, launchTx, 6);
    await insertLaunch('old', existingToken, existingPool, existingTx, 8);
    await envioPool.query(`INSERT INTO envio_fixture_v1."RawSwap" VALUES ($1,4663,$2,$3,$4,$5,$6,$7,$8,$9,$10,8963150,$11,$12,9,1700000000)`,
      ['real-swap', poolAddress, realToken, realToken, realToken, '100000000000000000', '-68057245261861571047346184',
        '2005366647941715384651103712059394', '36819258015569838458222', 202790, blockHash, swapTx]);
    const rpcAddresses: string[] = [];
    const legacyFactoryLower = legacyFactory.toLowerCase();
    const client = { readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      rpcAddresses.push(address.toLowerCase());
      if (functionName === 'name') return 'Real';
      if (functionName === 'symbol') return 'RL';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return poolAddress;
      if (functionName === 'graduationStatus') return [0n, 0n, false];
      throw new Error(functionName);
    } };
    try {
      const first = await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      expect(first).toEqual({ launchesWritten: 1, tradesWritten: 1 });
      // 4 metadata calls + 3 extended-metadata calls (logo/description/socials) to the token, plus 1
      // graduation-status call to the FACTORY (readV1Graduation's own readContract call targets the
      // factory address, not the token — be/src/launchpads/pons/v1/state.ts).
      expect(rpcAddresses.filter((address) => address === realToken)).toHaveLength(7);
      expect(rpcAddresses.filter((address) => address === legacyFactoryLower)).toHaveLength(1);
      const [newLaunch] = await db.select().from(launches).where(eq(launches.tokenAddress, realToken));
      expect(newLaunch.name).toBe('Real');
      expect(newLaunch.sourceLogId).toBeNull();
      expect(newLaunch.launchLogIndex).toBe(6);
      expect(newLaunch.lifecycleStatus).toBe('trading');
      const [oldLaunch] = await db.select().from(launches).where(eq(launches.tokenAddress, existingToken));
      expect(oldLaunch.sourceLogId).toBe(sourceLogId);
      expect((await db.select().from(trades).where(eq(trades.txHash, swapTx))).length).toBe(1);
      const [source] = await db.select().from(sources).where(eq(sources.id, 'pons-v1-legacy'));
      expect(source.confirmedToBlock).toBe(8963150n);
      expect(source.status).toBe('backfilling');
      await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      expect((await db.select().from(launches).where(eq(launches.tokenAddress, realToken))).length).toBe(1);
      expect((await db.select().from(launches).where(eq(launches.tokenAddress, existingToken))).length).toBe(1);
      // Reconciliation rebuilds the recent Envio launch every cycle (its block is inside the fixture's
      // pinned window); the old RPC launch never needs metadata/graduation calls.
      expect(rpcAddresses.filter((address) => address === realToken)).toHaveLength(14);
      expect(rpcAddresses.filter((address) => address === legacyFactoryLower)).toHaveLength(2);
      expect(rpcAddresses.every((address) => address === realToken || address === legacyFactoryLower)).toBe(true);
    } finally {
      await db.delete(trades).where(eq(trades.txHash, swapTx));
      await db.delete(venues).where(eq(venues.tokenAddress, realToken));
      await db.delete(venues).where(eq(venues.tokenAddress, existingToken));
      await db.delete(launches).where(eq(launches.tokenAddress, realToken));
      await db.delete(launches).where(eq(launches.tokenAddress, existingToken));
      await db.delete(rawLogs).where(eq(rawLogs.id, sourceLogId));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawSwap" WHERE id = $1', ['real-swap']);
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id IN ($1,$2)', ['real', 'old']);
    }
  });

  it('attributes a launch to pons-v1-active by factoryAddress, not the hardcoded legacy factory', async () => {
    const activeFactory = getPonsFactorySources().find((factory) => factory.id === 'pons-v1-active')!.factory;
    const token = '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a';
    const poolAddress = '0x9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b';
    const launchTx = '0x' + '9c'.repeat(32);
    const blockHash = '0x' + '9d'.repeat(32);
    const client = { readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'name') return 'Active Token';
      if (functionName === 'symbol') return 'ACT';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return poolAddress;
      if (functionName === 'graduationStatus') return [0n, 0n, false];
      throw new Error(functionName);
    } };
    try {
      for (const id of ['pons-v1-active', 'pons-v1-active-trades']) {
        await db.insert(sources).values({ id, chainId: 4663, version: 'v1', factoryAddress: activeFactory,
          startBlock: 8991118n, scannedToBlock: 8991118n, confirmedToBlock: 8991118n, status: 'backfilling' }).onConflictDoNothing();
      }
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8991200,$7,$8,$9)`,
        ['active', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, activeFactory, blockHash, launchTx, 3]);
      const result = await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      expect(result.launchesWritten).toBe(1);
      const [launch] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(launch.sourceId).toBe('pons-v1-active');
      expect(launch.factoryAddress.toLowerCase()).toBe(activeFactory.toLowerCase());
      const [venue] = await db.select().from(venues).where(eq(venues.tokenAddress, token));
      expect(venue.sourceId).toBe('pons-v1-active-trades');
      const [source] = await db.select().from(sources).where(eq(sources.id, 'pons-v1-active'));
      expect(source).toBeDefined();
    } finally {
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['active']);
    }
  });

  it('reads real graduation status via RPC instead of hardcoding trading (final review, Important 5)', async () => {
    const token = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
    const poolAddress = '0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b';
    const launchTx = '0x' + '7c'.repeat(32);
    const blockHash = '0x' + '7d'.repeat(32);
    try {
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        ['graduated', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, launchTx, 1]);
      const graduatedClient = { readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') return 'Graduated Token';
        if (functionName === 'symbol') return 'GRAD';
        if (functionName === 'decimals') return 18;
        if (functionName === 'liquidityPool') return poolAddress;
        if (functionName === 'graduationStatus') return [0n, 0n, true];
        throw new Error(functionName);
      } };
      const result = await syncV1LegacyToReal(envioPool, db, fixtureTables, graduatedClient);
      expect(result.launchesWritten).toBe(1);
      const [launch] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(launch.lifecycleStatus).toBe('graduated');
    } finally {
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['graduated']);
    }
  });

  it('reads and persists extended metadata and launch timestamp alongside the required V1 fields', async () => {
    const token = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
    const poolAddress = '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f';
    const launchTx = '0x' + '5e'.repeat(32);
    const blockHash = '0x' + '5f'.repeat(32);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') return 'Test Token';
        if (functionName === 'symbol') return 'TEST';
        if (functionName === 'decimals') return 18;
        if (functionName === 'liquidityPool') return poolAddress;
        if (functionName === 'graduationStatus') return [0n, 0n, false];
        if (functionName === 'logo') return 'ipfs://bafkreitest';
        if (functionName === 'description') return 'A real token';
        if (functionName === 'socials') return ['https://x.com/example', '', '', 'https://example.com', ''];
        throw new Error(`unexpected functionName ${functionName}`);
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    };
    try {
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        ['extended', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, launchTx, 2]);
      await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(row.logoUri).toBe('ipfs://bafkreitest');
      expect(row.description).toBe('A real token');
      expect(row.websiteUrl).toBe('https://example.com');
      expect(row.twitterUrl).toBe('https://x.com/example');
      expect(row.launchTimestamp).toBe(1_700_000_000);
    } finally {
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['extended']);
    }
  });

  it('enqueues a feed-resolution job for a newly-inserted launch\'s quote asset', async () => {
    const token = '0x7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e';
    const poolAddress = '0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f';
    const launchTx = '0x' + '7e'.repeat(32);
    const blockHash = '0x' + '7f'.repeat(32);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') return 'Job Token';
        if (functionName === 'symbol') return 'JOB';
        if (functionName === 'decimals') return 18;
        if (functionName === 'liquidityPool') return poolAddress;
        if (functionName === 'graduationStatus') return [0n, 0n, false];
        throw new Error('execution reverted');
      },
      getBlock: async () => { throw new Error('timeout'); },
    };
    try {
      await pool.query("DELETE FROM price_jobs WHERE job_type = 'feed_resolution' AND quote_asset_address = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'");
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        ['jobtest', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, launchTx, 4]);
      await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      const jobs = await pool.query("SELECT quote_asset_address FROM price_jobs WHERE job_type = 'feed_resolution' AND quote_asset_address = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'");
      expect(jobs.rows).toHaveLength(1);
    } finally {
      await pool.query("DELETE FROM price_jobs WHERE job_type = 'feed_resolution' AND quote_asset_address = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'");
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['jobtest']);
    }
  });

  it('indexes through a transient optional read failure while retaining per-function retry state', async () => {
    const token = '0x4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e';
    const poolAddress = '0x4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f';
    const launchTx = '0x' + '4e'.repeat(32);
    const blockHash = '0x' + '4f'.repeat(32);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') return 'Test Token';
        if (functionName === 'symbol') return 'TEST';
        if (functionName === 'decimals') return 18;
        if (functionName === 'liquidityPool') return poolAddress;
        if (functionName === 'graduationStatus') return [0n, 0n, false];
        if (functionName === 'logo') throw new HttpRequestError({ url: 'https://rpc.example', status: 429 });
        if (functionName === 'description') throw new ContractFunctionRevertedError({ abi: ponsExtendedMetadataAbi, functionName });
        if (functionName === 'socials') return ['', '', '', '', ''];
        throw new Error(`unexpected ${functionName}`);
      },
      getBlock: async () => { throw new HttpRequestError({ url: 'https://rpc.example', status: 503 }); },
    };
    try {
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        ['nullextended', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, launchTx, 3]);
      await syncV1LegacyToReal(envioPool, db, fixtureTables, client);
      const [row] = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(row.name).toBe('Test Token'); // required fields still indexed
      expect(row.logoUri).toBeNull();
      expect(row.launchTimestamp).toBeNull();
      expect(row.logoReadState).toBe('pending');
      expect(row.descriptionReadState).toBe('done');
      expect(row.socialsReadState).toBe('done');
      expect(row.timestampReadState).toBe('pending');
    } finally {
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['nullextended']);
    }
  });

  it('leaves the reorg window untouched when an RPC call fails mid-rebuild (final review, Critical 2)', async () => {
    // Deliberately NOT a simple repeated-digit address like 0x2222.../0x3333... — several other
    // integration test files (repository.integration.test.ts, market/aggregate.test.ts) already use
    // those exact addresses as venue refs for a DIFFERENT token. Since a venue's id is derived only
    // from (chainId, kind, ref) — not tokenAddress — a colliding ref makes onConflictDoNothing silently
    // skip this test's own venue insert against another file's leftover row (found live, debugging
    // this exact test).
    const token = '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
    const poolAddress = '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c3';
    const launchTx = '0x' + 'c2'.repeat(32);
    const swapTx = '0x' + 'c3'.repeat(32);
    const blockHash = '0x' + 'c4'.repeat(32);
    const workingClient = { readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'name') return 'Atomic';
      if (functionName === 'symbol') return 'AT';
      if (functionName === 'decimals') return 18;
      if (functionName === 'liquidityPool') return poolAddress;
      if (functionName === 'graduationStatus') return [0n, 0n, false];
      throw new Error(functionName);
    } };
    const failingClient = { readContract: async () => { throw new Error('simulated RPC failure (403/429)'); } };
    try {
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawLaunch" VALUES ($1,4663,$2,$3,$4,$5,$6,8963150,$7,$8,$9)`,
        ['atomic', token, token, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', poolAddress, legacyFactory, blockHash, launchTx, 12]);
      // First cycle: succeeds, writes the launch — this launch's block (8963150) is inside every
      // subsequent cycle's reorg window too (fixture progress is pinned at 8963150, window = 500
      // blocks back), so the next cycle will always try to rebuild (not reuse) it.
      const first = await syncV1LegacyToReal(envioPool, db, fixtureTables, workingClient);
      expect(first.launchesWritten).toBe(1);
      expect((await db.select().from(launches).where(eq(launches.tokenAddress, token)))[0].name).toBe('Atomic');
      expect((await db.select().from(venues).where(eq(venues.tokenAddress, token)))).toHaveLength(1);

      // Second cycle: RPC fails. The whole call must throw, and — this is the actual regression
      // check — the launch written by the first cycle must still be there afterward, because the
      // pre-fetch now happens before reconcileReorgWindow ever runs.
      await envioPool.query(`INSERT INTO envio_fixture_v1."RawSwap" VALUES ($1,4663,$2,$3,$4,$5,$6,$7,$8,$9,$10,8963150,$11,$12,20,1700000001)`,
        ['atomic-swap', poolAddress, token, token, token, '100000000000000000', '-68057245261861571047346184',
          '2005366647941715384651103712059394', '36819258015569838458222', 202790, blockHash, swapTx]);
      await expect(syncV1LegacyToReal(envioPool, db, fixtureTables, failingClient)).rejects.toThrow('simulated RPC failure');
      const survivingLaunch = await db.select().from(launches).where(eq(launches.tokenAddress, token));
      expect(survivingLaunch).toHaveLength(1);
      expect(survivingLaunch[0].name).toBe('Atomic');
      // The venue/trade from the first (successful) cycle must also still be there — the failed
      // second cycle must not have deleted them either.
      expect((await db.select().from(venues).where(eq(venues.tokenAddress, token)))).toHaveLength(1);
    } finally {
      await db.delete(trades).where(eq(trades.txHash, swapTx));
      await db.delete(venues).where(eq(venues.tokenAddress, token));
      await db.delete(launches).where(eq(launches.tokenAddress, token));
      await envioPool.query('DELETE FROM envio_fixture_v1."RawSwap" WHERE id = $1', ['atomic-swap']);
      await envioPool.query('DELETE FROM envio_fixture_v1."RawLaunch" WHERE id = $1', ['atomic']);
    }
  });
});
