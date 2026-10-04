import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { envioSyncCursors } from '../db/schema.js';
import { readRawPage } from './incrementalPage.js';
import { claimSyncCursor, advanceSyncCursor } from './incrementalCursor.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool } = createDatabase(databaseUrl);

// A throwaway Postgres schema on the same test database stands in for one of Envio's raw tables —
// shaped like the real RawLaunch/RawSwap/etc. entities (id, chainId, blockNumber, logIndex), which is
// all readRawPage's keyset query touches. See runSync.integration.test.ts for the same pattern.
const envioPool = new Pool({ connectionString: databaseUrl });
const rawTable = 'envio_fixture_cursor."RawTestEvent"';
const testChainId = 999001;

beforeAll(async () => {
  await envioPool.query('CREATE SCHEMA IF NOT EXISTS envio_fixture_cursor');
  await envioPool.query(`CREATE TABLE IF NOT EXISTS ${rawTable} (
    id text primary key, "chainId" int, "blockNumber" numeric, "logIndex" int, label text)`);
  await envioPool.query(`DELETE FROM ${rawTable} WHERE "chainId" = $1`, [testChainId]);
});

afterAll(async () => {
  await envioPool.query(`DROP SCHEMA envio_fixture_cursor CASCADE`);
  // Scoped to this file's own test chain ID only, never a blanket delete of the shared cursor table.
  await db.delete(envioSyncCursors).where(eq(envioSyncCursors.chainId, testChainId));
  await pool.end();
  await envioPool.end();
});

async function insertRaw(id: string, blockNumber: number, logIndex: number, label = ''): Promise<void> {
  await envioPool.query(`INSERT INTO ${rawTable} (id, "chainId", "blockNumber", "logIndex", label) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (id) DO NOTHING`, [id, testChainId, blockNumber, logIndex, label]);
}

const genesis = { blockNumber: 0n, logIndex: -1, rawId: '' };

describe('readRawPage', () => {
  it('returns rows in strict (blockNumber, logIndex, id) order regardless of insertion order', async () => {
    await insertRaw('order-c', 100, 5);
    await insertRaw('order-a', 105, 2);
    await insertRaw('order-b', 100, 1);

    const page = await readRawPage(envioPool, { table: rawTable, chainId: testChainId, after: genesis, fence: 1000n, limit: 10 });
    const ordered = page.rows.filter((row) => String(row.id).startsWith('order-'));
    expect(ordered.map((row) => row.id)).toEqual(['order-b', 'order-c', 'order-a']);
  });

  it('breaks ties on id when two rows share the same (blockNumber, logIndex)', async () => {
    await insertRaw('tie-m1', 110, 3);
    await insertRaw('tie-m2', 110, 3);

    const first = await readRawPage(envioPool, { table: rawTable, chainId: testChainId,
      after: { blockNumber: 109n, logIndex: 999, rawId: '' }, fence: 1000n, limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.id).toBe('tie-m1');
    expect(first.lastPosition).toEqual({ blockNumber: 110n, logIndex: 3, rawId: 'tie-m1' });

    const second = await readRawPage(envioPool, { table: rawTable, chainId: testChainId,
      after: first.lastPosition!, fence: 1000n, limit: 1 });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).toBe('tie-m2');
  });

  it('never returns a row past the fixed Envio fence', async () => {
    await insertRaw('fence-in', 150, 1);
    await insertRaw('fence-out', 300, 1);

    const page = await readRawPage(envioPool, { table: rawTable, chainId: testChainId,
      after: { blockNumber: 149n, logIndex: 999, rawId: '' }, fence: 200n, limit: 10 });
    const ids = page.rows.map((row) => row.id);
    expect(ids).toContain('fence-in');
    expect(ids).not.toContain('fence-out');
  });

  it('rejects an unsafe table identifier instead of interpolating it into SQL', async () => {
    await expect(readRawPage(envioPool, {
      table: `${rawTable}; DROP TABLE envio_fixture_cursor."RawTestEvent";--`,
      chainId: testChainId, after: genesis, fence: 1000n, limit: 10,
    })).rejects.toThrow(/unsafe|unrecognized/i);
  });
});

describe('claimSyncCursor / advanceSyncCursor', () => {
  it('advances the block watermark on an empty range with no new position', async () => {
    const key = { chainId: testChainId, stream: 'v1-launch' as const, lane: 'tail' as const };
    const claimed = await claimSyncCursor(db, key);
    expect(claimed.position).toEqual(genesis);
    expect(claimed.processedWatermark).toBeNull();

    await advanceSyncCursor(db, key, claimed.position, 500n);
    const after = await claimSyncCursor(db, key);
    expect(after.position).toEqual(genesis);
    expect(after.processedWatermark).toBe(500n);
  });

  it('persists the advanced position across a simulated restart', async () => {
    const key = { chainId: testChainId, stream: 'v2-curve' as const, lane: 'history' as const };
    await claimSyncCursor(db, key);
    const newPosition = { blockNumber: 777n, logIndex: 4, rawId: 'restart-id' };
    await advanceSyncCursor(db, key, newPosition, 1000n);

    // "Restart" = a fresh claim call, exactly what a freshly started process does.
    const resumed = await claimSyncCursor(db, key);
    expect(resumed.position).toEqual(newPosition);
    expect(resumed.processedWatermark).toBe(1000n);
  });

  it('rejects advancing a cursor position past the given processed-block fence', async () => {
    const key = { chainId: testChainId, stream: 'v4-swap' as const, lane: 'tail' as const };
    await claimSyncCursor(db, key);
    await expect(advanceSyncCursor(db, key, { blockNumber: 900n, logIndex: 0, rawId: 'x' }, 500n))
      .rejects.toThrow(/exceeds|fence|processed/i);
  });
});
