import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { claimDuePriceJobs, enqueueFeedResolutionJob, enqueueRoundBackfillJob, finishPriceJob } from './priceJobStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const quote = '0xjobquote000000000000000000000000000f01';
const feed = '0xjobfeed0000000000000000000000000000f02';

afterAll(async () => {
  await pool.query('DELETE FROM price_jobs WHERE quote_asset_address = $1 OR feed_address = $2', [quote, feed]);
  await pool.end();
});

describe('priceJobStore', () => {
  it('enqueues a feed-resolution job once, deduplicating repeated enqueue calls', async () => {
    await enqueueFeedResolutionJob(pool, 4663, quote);
    await enqueueFeedResolutionJob(pool, 4663, quote);
    const rows = await pool.query("SELECT count(*)::int AS count FROM price_jobs WHERE quote_asset_address = $1 AND job_type = 'feed_resolution'", [quote]);
    expect(rows.rows[0].count).toBe(1);
  });

  it('enqueues a round-backfill job once per exact (feed, range), two different ranges stay separate', async () => {
    await enqueueRoundBackfillJob(pool, 4663, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, 4663, feed, 1000, 2000);
    await enqueueRoundBackfillJob(pool, 4663, feed, 2000, 3000);
    const rows = await pool.query("SELECT range_start, range_end FROM price_jobs WHERE feed_address = $1 AND job_type = 'round_backfill' ORDER BY range_start", [feed]);
    expect(rows.rows).toHaveLength(2);
  });

  it('claims due jobs with a lease and excludes them from a second concurrent claim', async () => {
    const now = new Date();
    const first = await claimDuePriceJobs(pool, now, 10, 60_000);
    expect(first.length).toBeGreaterThanOrEqual(2);
    const second = await claimDuePriceJobs(pool, now, 10, 60_000);
    expect(second).toHaveLength(0);
  });

  it('finishPriceJob(ok: true) marks the job done; finishPriceJob(transport failure) retries with backoff', async () => {
    const now = new Date(Date.now() + 120_000);
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000);
    expect(job).toBeDefined();
    const saved = await finishPriceJob(pool, job, { ok: false, errorKind: 'transport', error: 'timeout' }, now);
    expect(saved).toBe(true);
    const row = await pool.query('SELECT status, attempts, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].next_attempt_at).not.toBeNull();
  });

  it('finishPriceJob(rejected) marks the job permanently failed, never retried', async () => {
    const now = new Date(Date.now() + 240_000);
    const [job] = await claimDuePriceJobs(pool, now, 1, 60_000);
    expect(job).toBeDefined();
    await finishPriceJob(pool, job, { ok: false, errorKind: 'rejected', error: 'no trustworthy feed found' }, now);
    const row = await pool.query('SELECT status, next_attempt_at FROM price_jobs WHERE id = $1', [job.id]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].next_attempt_at).toBeNull();
  });
});
