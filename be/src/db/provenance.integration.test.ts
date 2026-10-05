import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'provenance-test-src';
const token = `0x${'7a'.repeat(20)}`;
const venueId = 'provenance-test-venue';
const rawLogId = 'provenance-test-raw-log';

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'7b'.repeat(20)}`]);
  await pool.query(`INSERT INTO raw_logs (id, chain_id, source_id, block_number, block_hash, tx_hash, log_index, address, topics, data)
    VALUES ($1, $2, $3, 10, $4, $5, 0, $6, '[]'::jsonb, '0x') ON CONFLICT DO NOTHING`,
  [rawLogId, chainId, source, `0x${'aa'.repeat(32)}`, `0x${'ab'.repeat(32)}`, token]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, source_log_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, $4, 'Provenance', 'PRV', 18, 'pons', 'v2', $2, $2, 10, $5, 0, $6, 'ETH', 18, 'trading')
    ON CONFLICT DO NOTHING`,
  [chainId, token, source, rawLogId, `0x${'ab'.repeat(32)}`, `0x${'7c'.repeat(20)}`]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, source_log_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $3, $4, $5, 10, true) ON CONFLICT DO NOTHING`,
  [venueId, chainId, token, source, rawLogId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM venues WHERE id = $1', [venueId]);
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM raw_logs WHERE id = $1', [rawLogId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('legacy raw_logs provenance', () => {
  it('deleting a legacy raw log keeps the launch and venue it provenanced', async () => {
    await pool.query('DELETE FROM raw_logs WHERE id = $1', [rawLogId]);

    const launch = await pool.query('SELECT source_log_id FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
    const venue = await pool.query('SELECT source_log_id FROM venues WHERE id = $1', [venueId]);
    expect(launch.rows).toHaveLength(1);
    expect(launch.rows[0].source_log_id).toBeNull();
    expect(venue.rows).toHaveLength(1);
    expect(venue.rows[0].source_log_id).toBeNull();
  });
});
