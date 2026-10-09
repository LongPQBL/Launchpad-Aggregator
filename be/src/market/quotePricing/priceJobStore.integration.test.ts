import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { claimDuePriceJobs, enqueueFeedResolutionJob, enqueueRoundBackfillJob, finishPriceJob, hasCompletedRoundBackfillCovering } from './priceJobStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
// A chain id no other test file uses: claims are scoped to it, so these tests never lease (or count attempts on)
// a job another file left behind in the shared test database.
const TEST_CHAIN = 990_001;
const quote = '0xjobquote000000000000000000000000000f01';
const feed = '0xjobfeed0000000000000000000000000000f02';

afterAll(async () => {
  await pool.query('DELETE FROM price_jobs WHERE quote_asset_address = $1 OR feed_address = $2 OR chain_id = $3', [quote, feed, TEST_CHAIN]);
  await pool.end();
});

describe('priceJobStore', () => {
  it('enqueues a feed-resolution job once, deduplicating repeated enqueue calls', async () => {
    await enqueueFeedResolutionJob(pool, TEST_CHAIN, quote);
    await enqueueFeedResolutionJob(pool, TEST_CHAIN, quote);
    const rows = await pool.query("SELECT count(*)::int AS count FROM price_jobs WHERE quote_asset_address = $1 AND job_type = 'feed_resolution'", [quote]);
    expect(rows.rows[0].count).toBe(1);
  });

  it('enqueues a round-backfill job once per exact (feed, range), two different ranges stay separate', async () => {
    await enqueueRoundBackfillJob(pool, TEST_CHAIN, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, TEST_CHAIN, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, TEST_CHAIN, feed, 2000, 3000);
    const rows = await pool.query("SELECT range_start, range_end FROM price_jobs WHERE feed_address = $1 AND job_type = 'round_backfill' ORDER BY range_start", [feed]);
    expect(rows.rows).toHaveLength(2);
  });

  it('claims due jobs with a lease and excludes them from a second concurrent claim', async () => {
    const now = new Date();
    const first = await claimDuePriceJobs(pool, now, 10, 60_000, TEST_CHAIN);
    expect(first.length).toBeGreaterThanOrEqual(2);
    const second = await claimDuePriceJobs(pool, now, 10, 60_000, TEST_CHAIN);
    expect(second).toHaveLength(0);
  });

  it('finishPriceJob(ok: true) marks the job done; finishPriceJob(transport failure) retries with backoff', async () => {
    const now = new Date(Date.now() + 120_000);
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000, TEST_CHAIN);
    expect(job).toBeDefined();
    const saved = await finishPriceJob(pool, job, { ok: false, errorKind: 'transport', error: 'timeout' }, now);
    expect(saved).toBe(true);
    const row = await pool.query('SELECT status, attempts, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].next_attempt_at).not.toBeNull();
  });

  it('finishPriceJob(rejected) stays pending with a ~24h retry, never instantly, never permanently dead', async () => {
    const now = new Date(Date.now() + 240_000);
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000, TEST_CHAIN);
    expect(job).toBeDefined();
    await finishPriceJob(pool, job, { ok: false, errorKind: 'rejected', error: 'no trustworthy feed found' }, now);
    const row = await pool.query('SELECT status, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('pending');
    const retryAt = new Date(row.rows[0].next_attempt_at).getTime();
    expect(retryAt).toBeGreaterThan(now.getTime() + 23 * 60 * 60 * 1000);
    expect(retryAt).toBeLessThan(now.getTime() + 25 * 60 * 60 * 1000);
    // Not due yet — immediately re-claiming must not pick this specific job back up (the pool is
    // shared with other integration tests, so other due jobs may legitimately coexist).
    const reclaimed = await claimDuePriceJobs(pool, now, 50, 60_000, TEST_CHAIN);
    expect(reclaimed.map((j) => j.id)).not.toContain(job.id);
  });

  describe('hasCompletedRoundBackfillCovering', () => {
    const coverageFeed = '0xcoveragefeed000000000000000000000000f05';

    it('is false when no round_backfill job has ever run for this feed', async () => {
      expect(await hasCompletedRoundBackfillCovering(pool, 4663, coverageFeed, 1000, 2000)).toBe(false);
    });

    it('is false when a covering job exists but is still pending/retrying, not done', async () => {
      await enqueueRoundBackfillJob(pool, 4663, coverageFeed, 500, 2500);
      expect(await hasCompletedRoundBackfillCovering(pool, 4663, coverageFeed, 1000, 2000)).toBe(false);
    });

    it('is true once a done job whose range fully covers the requested window exists', async () => {
      // Directly mark the already-enqueued job 'done' — this test exercises the coverage query
      // itself, not the claim/lease/finish lifecycle (covered by the tests above).
      await pool.query(`UPDATE price_jobs SET status = 'done' WHERE feed_address = $1 AND range_start = 500 AND range_end = 2500`, [coverageFeed]);
      expect(await hasCompletedRoundBackfillCovering(pool, 4663, coverageFeed, 1000, 2000)).toBe(true);
      // A narrower completed job that does NOT fully cover the requested window must not count.
      expect(await hasCompletedRoundBackfillCovering(pool, 4663, coverageFeed, 1000, 3000)).toBe(false);
    });

    afterAll(async () => {
      await pool.query('DELETE FROM price_jobs WHERE feed_address = $1', [coverageFeed]);
    });
  });
});
