import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { createApiStore } from '../api/store.js';
import { enqueueParityRepair, readLaunchParityCoverage, resolveParityRepairs } from './repairRanges.js';
import { compareLaunchRange } from './launchParity.js';
import { saveParityReport } from './parityStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Repair tests require a _test database');
const { pool } = createDatabase(databaseUrl);
const source = getPonsFactorySources()[1]!;
const start = source.startBlock;
beforeEach(async () => {
  await pool.query('DELETE FROM launch_parity_reports WHERE source_id = $1', [source.id]);
  await pool.query('DELETE FROM launch_parity_repairs WHERE source_id = $1', [source.id]);
});
afterAll(async () => {
  await pool.query('DELETE FROM launch_parity_reports WHERE source_id = $1', [source.id]);
  await pool.query('DELETE FROM launch_parity_repairs WHERE source_id = $1', [source.id]);
  await pool.end();
});

describe('launch parity coverage and bounded repair requests', () => {
  it('keeps unaudited and provisional ranges incomplete', async () => {
    expect((await readLaunchParityCoverage(pool, source, start)).status).toBe('unverified');
    const report = compareLaunchRange({ source, fromBlock: start, toBlock: start, fence: start + 500n,
      chainEvents: [], envioRows: [], appRows: [], envioWatermark: start, appWatermark: start, provider: 'fixture' });
    await saveParityReport(pool, report);
    expect((await readLaunchParityCoverage(pool, source, start + 1n)).status).toBe('pending');
    expect((await readLaunchParityCoverage(pool, source, start)).status).toBe('complete');
  });

  it('marks a mismatched range incomplete and queues only that range', async () => {
    const event = { chainId: 4663, factoryAddress: source.factory, txHash: '0x' + 'e'.repeat(64),
      logIndex: 1, blockNumber: start + 1n, blockHash: '0x' + 'f'.repeat(64) };
    const report = compareLaunchRange({ source, fromBlock: start + 1n, toBlock: start + 1n, fence: start + 501n,
      chainEvents: [event], envioRows: [], appRows: [], envioWatermark: start + 1n, appWatermark: start + 1n,
      provider: 'fixture' });
    await saveParityReport(pool, report);
    expect((await readLaunchParityCoverage(pool, source, start + 1n)).status).toBe('mismatch');
    await expect(resolveParityRepairs(pool, source.id, start + 1n, start + 1n))
      .rejects.toThrow('successful parity audit');
    await enqueueParityRepair(pool, source.id, start + 1n, start + 1n, 'envio');
    await enqueueParityRepair(pool, source.id, start + 1n, start + 1n, 'envio');
    await enqueueParityRepair(pool, source.id, start + 1n, start + 1n, 'app');
    const rows = await pool.query('SELECT action, status FROM launch_parity_repairs WHERE source_id = $1 ORDER BY action', [source.id]);
    expect(rows.rows).toEqual([{ action: 'app_promotion', status: 'pending' },
      { action: 'envio_reindex', status: 'pending' }]);
  });

  it('accepts a newer repaired report for the same range and keeps a stalled watermark pending', async () => {
    const event = { chainId: 4663, factoryAddress: source.factory, txHash: '0x' + 'a'.repeat(64),
      logIndex: 2, blockNumber: start + 1n, blockHash: '0x' + 'b'.repeat(64) };
    await saveParityReport(pool, compareLaunchRange({ source, fromBlock: start, toBlock: start,
      fence: start + 501n, chainEvents: [], envioRows: [], appRows: [],
      envioWatermark: start, appWatermark: start, provider: 'fixture' }));
    await saveParityReport(pool, compareLaunchRange({ source, fromBlock: start + 1n, toBlock: start + 1n,
      fence: start + 502n, chainEvents: [event], envioRows: [event], appRows: [event],
      envioWatermark: start + 1n, appWatermark: start, provider: 'fixture' }));
    expect((await readLaunchParityCoverage(pool, source, start + 1n)).status).toBe('pending');
    await saveParityReport(pool, compareLaunchRange({ source, fromBlock: start + 1n, toBlock: start + 1n,
      fence: start + 503n, chainEvents: [event], envioRows: [event], appRows: [event],
      envioWatermark: start + 1n, appWatermark: start + 1n, provider: 'fixture' }));
    expect((await readLaunchParityCoverage(pool, source, start + 1n)).status).toBe('complete');
    await enqueueParityRepair(pool, source.id, start + 1n, start + 1n, 'envio');
    await resolveParityRepairs(pool, source.id, start + 1n, start + 1n);
    const status = await pool.query('SELECT status FROM launch_parity_repairs WHERE source_id = $1', [source.id]);
    expect(status.rows).toEqual([{ status: 'done' }]);
  });

  it('does not claim global coverage complete without finalized parity', async () => {
    const event = { chainId: 4663, factoryAddress: source.factory, txHash: '0x' + 'e'.repeat(64),
      logIndex: 1, blockNumber: start, blockHash: '0x' + 'f'.repeat(64) };
    await saveParityReport(pool, compareLaunchRange({ source, fromBlock: start, toBlock: start,
      fence: start + 500n, chainEvents: [event], envioRows: [], appRows: [],
      envioWatermark: start, appWatermark: start, provider: 'fixture' }));
    const result = await createApiStore(pool).getCoverage();
    expect(result.complete).toBe(false);
    expect(result.pendingSourceIds).toContain(source.id);
    expect(result.launchParity?.find((item) => item.sourceId === source.id)?.status).toBe('mismatch');
    expect(result.parityAlerts?.mismatchedSources).toBeGreaterThanOrEqual(1);
  });
});
