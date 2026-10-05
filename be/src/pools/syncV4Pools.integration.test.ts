import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createDatabase } from '../db/client.js';
import { poolCatalog, poolMembers, poolTrades, poolSyncCursors, poolPendingSwaps } from '../db/schema.js';
import { repairPoolWindow, syncV4PoolPage, updatePoolCoverage } from './syncV4Pools.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);
const envio = new Pool({ connectionString: databaseUrl });
const chainId = 996635;
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const hook = '0x3333333333333333333333333333333333333333';
const id = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [a, b, 3000, 60, hook],
));
const initializeTable = 'envio_fixture_pools."RawInitialize"';
const swapTable = 'envio_fixture_pools."RawSwap"';
const tables = { initialize: initializeTable, swap: swapTable };
const hash = (character: string) => `0x${character.repeat(64)}`;

async function addInitialize(block = 100n, blockHash = hash('a')) {
  await envio.query(`INSERT INTO ${initializeTable} (id, "chainId", "poolId", currency0, currency1, fee, "tickSpacing", hooks,
    "blockNumber", "blockHash", "txHash", "logIndex") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [`init-${blockHash}`, chainId, id, a, b, 3000, 60, hook, block.toString(), blockHash, hash('c'), 0]);
}
async function addSwap(block = 101n, blockHash = hash('a')) {
  await envio.query(`INSERT INTO ${swapTable} (id, "chainId", "poolId", amount0, amount1, "sqrtPriceX96", "txFrom", sender,
    "blockNumber", "blockHash", "txHash", "logIndex", "timestamp", fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [`swap-${blockHash}`, chainId, id, '-100', '200', '79228162514264337593543950336', a, b,
    block.toString(), blockHash, hash('d'), 1, 1_700_000_000, 3000]);
}
const input = (stream: 'initialize' | 'swap', lane: 'tail' | 'history' = 'history') =>
  ({ chainId, stream, lane, fence: 110n, limit: 10, tables });

beforeAll(async () => {
  await envio.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_pools');
  await envio.query(`CREATE TABLE IF NOT EXISTS ${initializeTable} (id text primary key, "chainId" int, "poolId" text,
    currency0 text, currency1 text, fee int, "tickSpacing" int, hooks text, "blockNumber" numeric,
    "blockHash" text, "txHash" text, "logIndex" int)`);
  await envio.query(`CREATE TABLE IF NOT EXISTS ${swapTable} (id text primary key, "chainId" int, "poolId" text,
    amount0 numeric, amount1 numeric, "sqrtPriceX96" numeric, "txFrom" text, sender text,
    "blockNumber" numeric, "blockHash" text, "txHash" text, "logIndex" int, "timestamp" int, fee int)`);
});
beforeEach(async () => {
  await envio.query(`TRUNCATE ${initializeTable}, ${swapTable}`);
  await db.delete(poolPendingSwaps).where(eq(poolPendingSwaps.chainId, chainId));
  await db.delete(poolTrades).where(eq(poolTrades.chainId, chainId));
  await db.delete(poolCatalog).where(eq(poolCatalog.chainId, chainId));
  await db.delete(poolSyncCursors).where(eq(poolSyncCursors.chainId, chainId));
});
afterAll(async () => {
  await db.delete(poolPendingSwaps).where(eq(poolPendingSwaps.chainId, chainId));
  await db.delete(poolTrades).where(eq(poolTrades.chainId, chainId));
  await db.delete(poolCatalog).where(eq(poolCatalog.chainId, chainId));
  await db.delete(poolSyncCursors).where(eq(poolSyncCursors.chainId, chainId));
  await envio.query('DROP SCHEMA envio_fixture_pools CASCADE');
  await envio.end(); await pool.end();
});

describe('V4 pool catalog sync', () => {
  it('promotes a non-Pons pool and its swap exactly once across replaying lanes', async () => {
    await addInitialize(); await addSwap();
    await syncV4PoolPage(envio, db, input('initialize'));
    await syncV4PoolPage(envio, db, input('swap'));
    await syncV4PoolPage(envio, db, input('initialize', 'tail'));
    await syncV4PoolPage(envio, db, input('swap', 'tail'));
    expect(await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId))).toHaveLength(1);
    expect(await db.select().from(poolMembers).where(eq(poolMembers.chainId, chainId))).toHaveLength(2);
    const swaps = await db.select().from(poolTrades).where(eq(poolTrades.chainId, chainId));
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ poolId: id, amount0Raw: '-100', amount1Raw: '200' });
  });

  it('claims finalized coverage only after historical Initialize and Swap scans drain', async () => {
    await addInitialize(); await addSwap();
    await syncV4PoolPage(envio, db, { ...input('initialize'), fence: 700n });
    await updatePoolCoverage(db, chainId, 700n);
    expect((await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId)))[0]?.coverageStatus).toBe('backfilling');
    await syncV4PoolPage(envio, db, { ...input('swap'), fence: 700n });
    await updatePoolCoverage(db, chainId, 700n);
    expect((await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId)))[0]?.coverageStatus).toBe('caught_up');
  });

  it('keeps a pool created inside the provisional 500-block window backfilling', async () => {
    await addInitialize(600n);
    await syncV4PoolPage(envio, db, { ...input('initialize'), fence: 700n });
    await syncV4PoolPage(envio, db, { ...input('swap'), fence: 700n });
    await updatePoolCoverage(db, chainId, 700n);
    expect((await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId)))[0]?.coverageStatus).toBe('backfilling');
  });

  it('keeps a swap that arrived before its Initialize and applies it after the pool appears', async () => {
    await addSwap();
    await syncV4PoolPage(envio, db, input('swap'));
    expect(await db.select().from(poolPendingSwaps).where(eq(poolPendingSwaps.chainId, chainId))).toHaveLength(1);
    await addInitialize();
    await syncV4PoolPage(envio, db, input('initialize'));
    await syncV4PoolPage(envio, db, input('swap'));
    expect(await db.select().from(poolTrades).where(eq(poolTrades.chainId, chainId))).toHaveLength(1);
    expect(await db.select().from(poolPendingSwaps).where(eq(poolPendingSwaps.chainId, chainId))).toHaveLength(0);
  });

  it('removes a stale swap and Initialize after a reorg without touching unrelated tables', async () => {
    await addInitialize(); await addSwap();
    await syncV4PoolPage(envio, db, input('initialize'));
    await syncV4PoolPage(envio, db, input('swap'));
    await envio.query(`TRUNCATE ${initializeTable}, ${swapTable}`);
    await repairPoolWindow(envio, db, { chainId, fence: 110n, depth: 20n, tables });
    expect(await db.select().from(poolTrades).where(eq(poolTrades.chainId, chainId))).toEqual([]);
    expect(await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId))).toEqual([]);
  });

  it('replays a replacement Initialize and swap after a block-hash change', async () => {
    await addInitialize(); await addSwap();
    await syncV4PoolPage(envio, db, input('initialize'));
    await syncV4PoolPage(envio, db, input('swap'));
    await envio.query(`TRUNCATE ${initializeTable}, ${swapTable}`);
    await addInitialize(100n, hash('e')); await addSwap(101n, hash('e'));
    expect(await repairPoolWindow(envio, db, { chainId, fence: 110n, depth: 20n, tables }))
      .toEqual({ removedPools: 1, removedSwaps: 1 });
    await syncV4PoolPage(envio, db, input('initialize'));
    await syncV4PoolPage(envio, db, input('swap'));
    expect((await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId)))[0]?.blockHash).toBe(hash('e'));
    expect((await db.select().from(poolTrades).where(eq(poolTrades.chainId, chainId)))[0]?.blockHash).toBe(hash('e'));
  });

  it('resumes a page after its last row without claiming the unread fence', async () => {
    await addInitialize(); await addSwap();
    await envio.query(`INSERT INTO ${swapTable} SELECT 'swap-two', "chainId", "poolId", amount0, amount1,
      "sqrtPriceX96", "txFrom", sender, 102, "blockHash", $1, 1, "timestamp", fee FROM ${swapTable}`, [hash('e')]);
    await syncV4PoolPage(envio, db, input('initialize'));
    const first = await syncV4PoolPage(envio, db, { ...input('swap'), limit: 1 });
    expect(first.cursor.blockNumber).toBe(101n);
    expect(first.processedWatermark).toBe(100n);
    const second = await syncV4PoolPage(envio, db, { ...input('swap'), limit: 1 });
    expect(second.cursor.blockNumber).toBe(102n);
    expect(await db.select().from(poolTrades).where(eq(poolTrades.chainId, chainId))).toHaveLength(2);
  });

  it('leaves the cursor unchanged if the page fails before commit', async () => {
    await addInitialize();
    await envio.query(`INSERT INTO ${initializeTable} SELECT 'bad-init', "chainId", $1, currency0,
      currency1, fee, "tickSpacing", hooks, 101, "blockHash", "txHash", "logIndex" FROM ${initializeTable}`, [hash('f')]);
    await expect(syncV4PoolPage(envio, db, input('initialize'))).rejects.toThrow();
    expect(await db.select().from(poolCatalog).where(eq(poolCatalog.chainId, chainId))).toEqual([]);
    const cursors = await db.select().from(poolSyncCursors).where(and(eq(poolSyncCursors.chainId, chainId),
      eq(poolSyncCursors.stream, 'initialize')));
    expect(cursors[0]?.blockNumber).toBe(0n);
  });
});
