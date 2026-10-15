import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const beDirectory = fileURLToPath(new URL('../..', import.meta.url));
const quoteAssets = [
  '0x0000000000000000000000000000000000000000',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
];

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = ANY($1)', [quoteAssets]);
  await pool.end();
});

describe('seedKnownQuoteFeeds CLI', () => {
  it('persists each verified proxy with its on-chain aggregator, including the shared ETH feed', async () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/seedKnownQuoteFeeds.ts'], {
      cwd: beDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);

    const result = await pool.query(
      `SELECT quote_asset_address, feed_address, aggregator_address, verification_status
       FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = ANY($1)
       ORDER BY quote_asset_address`,
      [quoteAssets],
    );
    expect(result.rows).toEqual([
      { quote_asset_address: quoteAssets[0], feed_address: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9', aggregator_address: '0x6091e64eb7138eef066a80fd3a0d7427b91f2721', verification_status: 'verified' },
      { quote_asset_address: quoteAssets[1], feed_address: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9', aggregator_address: '0x6091e64eb7138eef066a80fd3a0d7427b91f2721', verification_status: 'verified' },
      { quote_asset_address: quoteAssets[2], feed_address: '0x61b7e5650328764b076a108eff5fa7282a1b9ad2', aggregator_address: '0x8beee3503f6860d5dac4ce26b5eee92982951c2e', verification_status: 'verified' },
      { quote_asset_address: quoteAssets[3], feed_address: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15', aggregator_address: '0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2', verification_status: 'verified' },
    ]);
  });
});
