import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { maintainRollingWindows } from './priceEnrichment.js';
import { upsertQuoteFeed } from './feedRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const verifiedQuote = '0xmaintainverified00000000000000000000f01';
const verifiedFeed = '0xmaintainverifiedfeed000000000000000f02';
const rejectedQuote = '0xmaintainrejected00000000000000000000f03';
const rejectedFeed = '0xmaintainrejectedfeed000000000000000f04';

afterAll(async () => {
  await pool.query('DELETE FROM price_jobs WHERE chain_id = $1 AND feed_address = ANY($2)', [chainId, [verifiedFeed, rejectedFeed]]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1 AND quote_asset_address = ANY($2)', [chainId, [verifiedQuote, rejectedQuote]]);
  await pool.end();
});

describe('maintainRollingWindows', () => {
  it('enqueues a bucketed round-backfill job per verified feed, never for a rejected one, and is idempotent within the same bucket', async () => {
    const now = new Date();
    await upsertQuoteFeed(pool, { chainId, quoteAssetAddress: verifiedQuote as never, feedAddress: verifiedFeed as never,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now });
    await upsertQuoteFeed(pool, { chainId, quoteAssetAddress: rejectedQuote as never, feedAddress: rejectedFeed as never,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'rejected', now });

    const enqueuedFirst = await maintainRollingWindows(pool, chainId, now);
    expect(enqueuedFirst).toBe(1); // only the verified feed

    const jobs = await pool.query(`SELECT feed_address, range_start, range_end FROM price_jobs WHERE chain_id = $1 AND job_type = 'round_backfill' AND feed_address = ANY($2)`,
      [chainId, [verifiedFeed, rejectedFeed]]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].feed_address).toBe(verifiedFeed);
    expect(Number(jobs.rows[0].range_end) - Number(jobs.rows[0].range_start)).toBe(300);

    // Calling again within the same 5-minute bucket must not create a second row (relies on the
    // existing price_jobs dedup index) — confirms the bucketing is stable, not re-randomized per call.
    await maintainRollingWindows(pool, chainId, now);
    const jobsAfterSecondCall = await pool.query(`SELECT count(*)::int AS n FROM price_jobs WHERE chain_id = $1 AND job_type = 'round_backfill' AND feed_address = $2`,
      [chainId, verifiedFeed]);
    expect(jobsAfterSecondCall.rows[0].n).toBe(1);
  });
});
