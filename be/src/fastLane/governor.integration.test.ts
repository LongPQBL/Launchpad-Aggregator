import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { readEnvioLagBlocks } from './governor.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const chainId = 910_004; // private to this file
const streams = ['v1-swap', 'v2-curve', 'v2-buyback', 'v4-swap'];

async function setWatermark(stream: string, lane: string, watermark: number) {
  await pool.query(`INSERT INTO envio_sync_cursors (chain_id, stream, lane, block_number, log_index, raw_id, processed_watermark)
    VALUES ($1,$2,$3,0,-1,'',$4) ON CONFLICT (chain_id, stream, lane) DO UPDATE SET processed_watermark = EXCLUDED.processed_watermark`, [chainId, stream, lane, watermark]);
}
beforeAll(() => pool.query('DELETE FROM envio_sync_cursors WHERE chain_id = $1', [chainId]));
afterAll(async () => { await pool.query('DELETE FROM envio_sync_cursors WHERE chain_id = $1', [chainId]); await pool.end(); });

describe('readEnvioLagBlocks', () => {
  it('is null until every trade stream has a position', async () => {
    await setWatermark('v1-swap', 'tail', 990);
    expect(await readEnvioLagBlocks(pool, chainId, 1000n)).toBeNull();
  });

  it('measures the slowest stream, using the better of its tail and history lanes', async () => {
    for (const stream of streams) await setWatermark(stream, 'tail', 995);
    await setWatermark('v2-curve', 'tail', 970); // the slowest stream...
    await setWatermark('v2-curve', 'history', 100); // ...whose history lane is far behind but irrelevant
    expect(await readEnvioLagBlocks(pool, chainId, 1000n)).toBe(30);
    await setWatermark('v2-curve', 'history', 990); // the history lane is closer: it wins
    expect(await readEnvioLagBlocks(pool, chainId, 1000n)).toBe(10); // v2-curve is still the slowest stream (990 against 995)
  });

  it('never reports a negative lag', async () => {
    expect(await readEnvioLagBlocks(pool, chainId, 900n)).toBe(0);
  });
});
