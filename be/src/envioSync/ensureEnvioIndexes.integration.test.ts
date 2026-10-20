import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ensureEnvioReadIndexes, envioStorageReady } from './ensureEnvioIndexes.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(connectionString).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const schema = `envio_idx_${process.pid}`;

describe('ensureEnvioReadIndexes', () => {
  const pool = new pg.Pool({ connectionString });
  const table = `${schema}."RawCurveTrade"`;
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${table} (id text PRIMARY KEY, "chainId" int, "blockNumber" numeric, "logIndex" int, "txHash" text)`);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  it('creates the page and tx lookup indexes, skips missing tables, and is a no-op the second time', async () => {
    const first = await ensureEnvioReadIndexes(pool, [table, `${schema}."RawNotThereYet"`], { waitForEnvio: false });
    expect(first.created.sort()).toEqual([`${schema}.sync_rawcurvetrade_page`, `${schema}.sync_rawcurvetrade_tx`]);
    expect(first.skippedMissingTables).toEqual([`${schema}."RawNotThereYet"`]);
    const second = await ensureEnvioReadIndexes(pool, [table], { waitForEnvio: false });
    expect(second.created).toEqual([]);
  });

  it('reports Envio as not ready while its progress table is absent, so no index is built during its initialization', async () => {
    expect(await envioStorageReady(pool)).toBe(false); // the test database has no envio.envio_chains
    expect(await ensureEnvioReadIndexes(pool, [table])).toMatchObject({ created: [] });
  });
});
