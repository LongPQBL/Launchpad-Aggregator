import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface PriceJob {
  id: string; jobType: 'feed_resolution' | 'round_backfill'; quoteAssetAddress: string | null;
  feedAddress: string | null; rangeStart: number | null; rangeEnd: number | null; attempts: number; leaseId: string;
}

export async function enqueueFeedResolutionJob(pool: Pool, chainId: number, quoteAssetAddress: string): Promise<void> {
  await pool.query(
    `INSERT INTO price_jobs (id, chain_id, job_type, quote_asset_address)
     VALUES ($1, $2, 'feed_resolution', $3)
     ON CONFLICT (chain_id, job_type, coalesce(quote_asset_address, ''), coalesce(feed_address, ''), coalesce(range_start, -1), coalesce(range_end, -1)) DO NOTHING`,
    [randomUUID(), chainId, quoteAssetAddress.toLowerCase()],
  );
}

export async function enqueueRoundBackfillJob(pool: Pool, chainId: number, feedAddress: string, rangeStart: number, rangeEnd: number): Promise<void> {
  await pool.query(
    `INSERT INTO price_jobs (id, chain_id, job_type, feed_address, range_start, range_end)
     VALUES ($1, $2, 'round_backfill', $3, $4, $5)
     ON CONFLICT (chain_id, job_type, coalesce(quote_asset_address, ''), coalesce(feed_address, ''), coalesce(range_start, -1), coalesce(range_end, -1)) DO NOTHING`,
    [randomUUID(), chainId, feedAddress.toLowerCase(), rangeStart, rangeEnd],
  );
}

export async function claimDuePriceJobs(pool: Pool, now: Date, limit: number, leaseMs: number): Promise<PriceJob[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id, job_type, quote_asset_address, feed_address, range_start, range_end, attempts FROM price_jobs
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         AND (lease_until IS NULL OR lease_until <= $1)
       ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    const claims: PriceJob[] = [];
    for (const row of due.rows as Record<string, unknown>[]) {
      const leaseId = randomUUID();
      await client.query('UPDATE price_jobs SET lease_id = $1, lease_until = $2 WHERE id = $3',
        [leaseId, new Date(now.getTime() + leaseMs), row.id]);
      claims.push({
        id: String(row.id), jobType: row.job_type as PriceJob['jobType'],
        quoteAssetAddress: row.quote_asset_address === null ? null : String(row.quote_asset_address),
        feedAddress: row.feed_address === null ? null : String(row.feed_address),
        rangeStart: row.range_start === null ? null : Number(row.range_start),
        rangeEnd: row.range_end === null ? null : Number(row.range_end),
        attempts: Number(row.attempts), leaseId,
      });
    }
    await client.query('COMMIT');
    return claims;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function nextPriceJobRetryAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(60 * 2 ** Math.min(attempts, 6), 3600) * 1000);
}

export async function finishPriceJob(
  pool: Pool, job: PriceJob, outcome: { ok: true } | { ok: false; errorKind: 'transport' | 'unknown' | 'rejected'; error: string }, now: Date,
): Promise<boolean> {
  if (outcome.ok) {
    const result = await pool.query(`UPDATE price_jobs SET status = 'done', lease_id = NULL, lease_until = NULL WHERE id = $1 AND lease_id = $2`,
      [job.id, job.leaseId]);
    return result.rowCount === 1;
  }
  if (outcome.errorKind === 'rejected') {
    const result = await pool.query(
      `UPDATE price_jobs SET status = 'failed', last_error = $1, next_attempt_at = NULL, lease_id = NULL, lease_until = NULL WHERE id = $2 AND lease_id = $3`,
      [outcome.error, job.id, job.leaseId]);
    return result.rowCount === 1;
  }
  const attempts = job.attempts + 1;
  const result = await pool.query(
    `UPDATE price_jobs SET attempts = $1, last_error = $2, next_attempt_at = $3, lease_id = NULL, lease_until = NULL WHERE id = $4 AND lease_id = $5`,
    [attempts, outcome.error, nextPriceJobRetryAt(now, attempts), job.id, job.leaseId]);
  return result.rowCount === 1;
}
