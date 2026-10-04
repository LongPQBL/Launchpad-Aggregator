import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { compareLaunchRange, type ParityEvent } from './launchParity.js';
import { saveParityReport } from './parityStore.js';

const source = getPonsFactorySources()[0]!;
const start = source.startBlock;
const event: ParityEvent = { chainId: 4663, factoryAddress: source.factory, txHash: '0x' + 'a'.repeat(64),
  logIndex: 1, blockNumber: start, blockHash: '0x' + 'b'.repeat(64) };
const input = { source, fromBlock: start, toBlock: start, fence: start + 500n,
  chainEvents: [event], envioRows: [event], appRows: [event], envioWatermark: start, appWatermark: start, provider: 'fixture' };

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Parity tests require a _test database');
const { pool } = createDatabase(databaseUrl);
beforeAll(async () => { await pool.query('DELETE FROM launch_parity_reports WHERE source_id = $1', [source.id]); });
afterAll(async () => { await pool.query('DELETE FROM launch_parity_reports WHERE source_id = $1', [source.id]); await pool.end(); });

describe('three-way launch parity', () => {
  it('reports complete only for matching finalized event keys and hashes', async () => {
    const report = compareLaunchRange(input);
    expect(report.status).toBe('complete');
    expect(report.counts).toEqual({ chain: 1, envio: 1, app: 1 });
    await saveParityReport(pool, report);
    const row = (await pool.query('SELECT status, details FROM launch_parity_reports WHERE source_id = $1', [source.id])).rows[0];
    expect(row.status).toBe('complete');
    expect(row.details.counts).toEqual({ chain: 1, envio: 1, app: 1 });
  });

  it('locates missing raw versus missing app events', () => {
    expect(compareLaunchRange({ ...input, envioRows: [], appRows: [] }).missingEnvio).toHaveLength(1);
    expect(compareLaunchRange({ ...input, appRows: [] }).missingApp).toHaveLength(1);
  });

  it('reports extra and duplicate keys rather than inflating counts', () => {
    const extra = { ...event, txHash: '0x' + 'c'.repeat(64) };
    const appOnly = { ...event, txHash: '0x' + 'd'.repeat(64) };
    const report = compareLaunchRange({ ...input, envioRows: [event, event, extra], appRows: [event, extra, appOnly] });
    expect(report.counts).toEqual({ chain: 1, envio: 2, app: 3 });
    expect(report.duplicateKeys).toHaveLength(1);
    expect(report.extraEnvio).toHaveLength(1);
    expect(report.extraApp).toHaveLength(1);
    expect(report.status).toBe('mismatch');
  });

  it('reports changed block hash and missing app provenance', () => {
    expect(compareLaunchRange({ ...input, appRows: [{ ...event, blockHash: '0x' + 'd'.repeat(64) }] }).hashMismatches)
      .toHaveLength(1);
    expect(compareLaunchRange({ ...input, appRows: [{ ...event, blockHash: null }] }).hashMismatches)
      .toHaveLength(1);
  });

  it('does not certify a provisional range or a lagging app watermark', () => {
    expect(compareLaunchRange({ ...input, fence: start + 499n }).status).toBe('pending');
    expect(compareLaunchRange({ ...input, appWatermark: start - 1n }).status).toBe('pending');
  });
});
