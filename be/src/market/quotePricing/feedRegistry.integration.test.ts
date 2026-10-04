import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resolveVerifiedFeed, upsertQuoteFeed } from './feedRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const token = '0xfeed000000000000000000000000000000f001';

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_feeds WHERE quote_asset_address = $1', [token]);
  await pool.end();
});

describe('feedRegistry', () => {
  it('returns null for an address with no row at all', async () => {
    expect(await resolveVerifiedFeed(pool, 4663, token)).toBeNull();
  });

  it('returns null for a row marked unverified or rejected, only returns a verified one', async () => {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'rejected', now: new Date() });
    expect(await resolveVerifiedFeed(pool, 4663, token)).toBeNull();

    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: '0xaggregator000000000000000000000000f003', discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    const feed = await resolveVerifiedFeed(pool, 4663, token);
    expect(feed).toEqual({ chainId: 4663, quoteAssetAddress: token, feedAddress: '0xfeedaddr00000000000000000000000000f002',
      aggregatorAddress: '0xaggregator000000000000000000000000f003', discoverySource: 'test', verificationStatus: 'verified' });
  });

  it('matches by exact address only, case-insensitively, never by a different address', async () => {
    const feed = await resolveVerifiedFeed(pool, 4663, token.toUpperCase());
    expect(feed?.quoteAssetAddress).toBe(token);
    expect(await resolveVerifiedFeed(pool, 4663, '0x0000000000000000000000000000000000dead')).toBeNull();
  });

  it('upsert is idempotent and keyed by (chainId, quoteAssetAddress)', async () => {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: token, feedAddress: '0xnewfeed0000000000000000000000000000f9',
      aggregatorAddress: null, discoverySource: 'test-2', verificationStatus: 'verified', now: new Date() });
    const rows = await pool.query('SELECT count(*)::int AS count FROM quote_usd_feeds WHERE quote_asset_address = $1', [token]);
    expect(rows.rows[0].count).toBe(1);
    expect((await resolveVerifiedFeed(pool, 4663, token))?.feedAddress).toBe('0xnewfeed0000000000000000000000000000f9');
  });
});
