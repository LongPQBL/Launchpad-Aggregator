import type { Pool } from 'pg';
import { sql, type SQL } from 'drizzle-orm';

export const VOLUME_LEASE_SECONDS = 120;

export interface SqlExecutor { execute(query: SQL): PromiseLike<unknown> }

export interface LaunchKey { chainId: number; tokenAddress: string }
export interface VolumeClaim { key: LaunchKey; revision: number; leaseId: string }
export type RankCategory = 'positive' | 'zero' | 'null';
export type CompletenessReason = 'complete' | 'incomplete_coverage' | 'unpriced_trade' | 'updating';

export interface VolumeScore {
  volumeUsd: string | null;
  rankCategory: RankCategory;
  computedAt: Date;
  windowEnd: number;
  nextExpiryAt: Date | null;
  completenessReason: CompletenessReason;
  launchBlock: bigint;
  launchTxHash: string;
  launchLogIndex: number;
}

const RANK_ORDER: Record<RankCategory, number> = { positive: 0, zero: 1, null: 2 };

export async function invalidateLaunchVolume(tx: SqlExecutor, keys: readonly LaunchKey[], dueAt: Date): Promise<void> {
  const distinct = [...new Map(keys.map((key) => [`${key.chainId}:${key.tokenAddress}`, key])).values()];
  if (distinct.length === 0) return;
  const values = sql.join(distinct.map((key) => sql`(${key.chainId}::integer, ${key.tokenAddress}::text)`), sql`, `);
  // A launch deleted by reorg repair has no ranking left to recompute; its score row cascades with it.
  await tx.execute(sql`
    INSERT INTO launch_volume24h_jobs (chain_id, token_address, revision, due_at)
    SELECT k.chain_id, k.token_address, 1, ${dueAt}::timestamptz
    FROM (VALUES ${values}) AS k(chain_id, token_address)
    JOIN launches l ON l.chain_id = k.chain_id AND l.token_address = k.token_address
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      revision = launch_volume24h_jobs.revision + 1,
      due_at = LEAST(launch_volume24h_jobs.due_at, EXCLUDED.due_at),
      updated_at = now()`);
  await tx.execute(sql`
    UPDATE launch_volume24h_usd AS s SET
      volume_usd = NULL, rank_category = 'null', rank_order = 2, completeness_reason = 'updating'
    FROM (VALUES ${values}) AS k(chain_id, token_address)
    WHERE s.chain_id = k.chain_id AND s.token_address = k.token_address`);
}

export async function claimVolumeJobs(pool: Pool, now: Date, limit: number): Promise<VolumeClaim[]> {
  const result = await pool.query(`
    WITH due AS (
      SELECT chain_id, token_address FROM launch_volume24h_jobs
      WHERE due_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
      ORDER BY due_at, chain_id, token_address
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE launch_volume24h_jobs j SET
      lease_id = gen_random_uuid()::text,
      lease_until = $1::timestamptz + make_interval(secs => $3),
      attempts = j.attempts + 1
    FROM due
    WHERE j.chain_id = due.chain_id AND j.token_address = due.token_address
    RETURNING j.chain_id, j.token_address, j.revision, j.lease_id`, [now, limit, VOLUME_LEASE_SECONDS]);
  return result.rows.map((row) => ({
    key: { chainId: row.chain_id, tokenAddress: row.token_address },
    revision: row.revision,
    leaseId: row.lease_id,
  }));
}

export async function publishVolumeScore(pool: Pool, claim: VolumeClaim, score: VolumeScore): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query(`
      SELECT revision, lease_id FROM launch_volume24h_jobs
      WHERE chain_id = $1 AND token_address = $2 FOR UPDATE`, [claim.key.chainId, claim.key.tokenAddress]);
    const current = job.rows[0];
    if (!current || current.revision !== claim.revision || current.lease_id !== claim.leaseId) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`
      INSERT INTO launch_volume24h_usd (chain_id, token_address, volume_usd, rank_category, rank_order,
        completeness_reason, computed_at, window_end, next_expiry_at, revision, launch_block, launch_tx_hash, launch_log_index)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (chain_id, token_address) DO UPDATE SET
        volume_usd = EXCLUDED.volume_usd, rank_category = EXCLUDED.rank_category, rank_order = EXCLUDED.rank_order,
        completeness_reason = EXCLUDED.completeness_reason, computed_at = EXCLUDED.computed_at,
        window_end = EXCLUDED.window_end, next_expiry_at = EXCLUDED.next_expiry_at, revision = EXCLUDED.revision,
        launch_block = EXCLUDED.launch_block, launch_tx_hash = EXCLUDED.launch_tx_hash, launch_log_index = EXCLUDED.launch_log_index`,
    [claim.key.chainId, claim.key.tokenAddress, score.volumeUsd, score.rankCategory, RANK_ORDER[score.rankCategory],
      score.completenessReason, score.computedAt, score.windowEnd, score.nextExpiryAt, claim.revision,
      score.launchBlock, score.launchTxHash, score.launchLogIndex]);
    await client.query('DELETE FROM launch_volume24h_jobs WHERE chain_id = $1 AND token_address = $2', [claim.key.chainId, claim.key.tokenAddress]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Unlike invalidateLaunchVolume, scheduling leaves the published score in place: an expiry is a
// reminder that the rolling total may have changed, not a claim that the cached value is stale.
export async function scheduleLaunchVolumeExpiry(pool: Pool, key: LaunchKey, dueAt: Date): Promise<void> {
  await pool.query(`
    INSERT INTO launch_volume24h_jobs (chain_id, token_address, revision, due_at)
    SELECT l.chain_id, l.token_address, 1, $3::timestamptz FROM launches l
    WHERE l.chain_id = $1 AND l.token_address = $2
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      due_at = LEAST(launch_volume24h_jobs.due_at, EXCLUDED.due_at),
      updated_at = now()`, [key.chainId, key.tokenAddress, dueAt]);
}

export async function releaseVolumeClaim(pool: Pool, claim: VolumeClaim, retryAt: Date, errorMessage: string): Promise<void> {
  await pool.query(`
    UPDATE launch_volume24h_jobs SET lease_id = NULL, lease_until = NULL, last_error = $4, due_at = $3
    WHERE chain_id = $1 AND token_address = $2 AND lease_id = $5`,
  [claim.key.chainId, claim.key.tokenAddress, retryAt, errorMessage, claim.leaseId]);
}
