import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const sourceId = 'envio-migration-test';
const token = '0x7777777777777777777777777777777777777777';
const txHash = '0x' + 'd'.repeat(64);

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1,4663,'v1',$2,0,0,0,'backfilling') ON CONFLICT DO NOTHING`, [sourceId, token]);
});
afterAll(async () => {
  await pool.query('DELETE FROM lifecycle_transitions WHERE token_address = $1', [token]);
  await pool.query('DELETE FROM launches WHERE token_address = $1', [token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  await pool.end();
});

describe('Envio schema migration', () => {
  it('accepts a launch without raw log provenance and stores its launch log index', async () => {
    await pool.query('DELETE FROM launches WHERE token_address = $1', [token]);
    await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, source_log_id, name, symbol,
      token_decimals, platform, protocol_version, factory_address, deployer_address, launch_block,
      launch_tx_hash, launch_log_index, quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
      VALUES (4663,$1,$2,NULL,'X','X',18,'pons','v1',$1,$1,1,$3,5,$1,'ETH',18,'trading')`,
    [token, sourceId, txHash]);
    const result = await pool.query('SELECT source_log_id, launch_log_index FROM launches WHERE token_address = $1', [token]);
    expect(result.rows[0]).toEqual({ source_log_id: null, launch_log_index: 5 });
  });

  it('accepts a transition without raw log provenance using the composite key', async () => {
    await pool.query(`INSERT INTO lifecycle_transitions (source_log_id, chain_id, token_address, source_id, phase,
      kind, block_number, block_hash, tx_hash, log_index) VALUES (NULL,4663,$1,$2,2,'graduated',1,$3,$3,7)`,
    [token, sourceId, txHash]);
    const result = await pool.query('SELECT source_log_id FROM lifecycle_transitions WHERE tx_hash = $1', [txHash]);
    expect(result.rows[0].source_log_id).toBeNull();
  });
});
