import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase } from '../../db/client.js';
import { finishCoreMetadataLaunch, type ClaimedMetadataLaunch } from './metadataEnrichmentStore.js';
import type { CoreMetadataReadResults } from './coreMetadata.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { db, pool: drizzlePool } = createDatabase(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl });

const chainId = 4663;
const source = 'null-write-test-src';
const token = `0x${'e7'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const leaseId = 'null-write-regression-lease';

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'backfilling') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'e8'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status, core_metadata_read_state,
    metadata_lease_id, metadata_lease_until)
    VALUES ($1, $2, $3, NULL, NULL, NULL, 'pons', 'v2', $2, $2, 10, $4, 0, $5, 'ETH', 18, 'trading', 'pending', $6, now() + interval '5 minutes')
    ON CONFLICT DO NOTHING`, [chainId, token, source, `0x${'e9'.repeat(32)}`, quote, leaseId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await drizzlePool.end();
  await pool.end();
});

describe('finishCoreMetadataLaunch', () => {
  it('keeps a known quote asset decimals value when the read reports done with no value', async () => {
    const claim: ClaimedMetadataLaunch = {
      chainId, tokenAddress: token, launchBlock: 10n, launchTxHash: `0x${'e9'.repeat(32)}`, launchLogIndex: 0, leaseId,
      retryCount: 0, logoReadState: 'done', descriptionReadState: 'done', socialsReadState: 'done', timestampReadState: 'done',
      protocolVersion: 'v2', factoryAddress: token, quoteAssetAddress: quote, quoteAssetSymbol: 'ETH',
      coreMetadataReadState: 'pending', coreMetadataRetryCount: 0, metadataRetryCount: 0,
    } as ClaimedMetadataLaunch;
    const result = {
      name: { state: 'done', value: 'Null Write' }, symbol: { state: 'done', value: 'NWR' }, decimals: { state: 'done', value: 18 },
      graduated: { state: 'done', value: null }, quoteAssetSymbol: { state: 'done', value: null }, quoteAssetDecimals: { state: 'done', value: null },
    } as unknown as CoreMetadataReadResults;

    await finishCoreMetadataLaunch(db, claim, result, new Date());

    const row = (await pool.query('SELECT quote_asset_decimals, quote_asset_symbol, core_metadata_read_state FROM launches WHERE chain_id = $1 AND token_address = $2', [chainId, token])).rows[0];
    expect(row).toMatchObject({ quote_asset_decimals: 18, quote_asset_symbol: 'ETH', core_metadata_read_state: 'done' });
  });
});
