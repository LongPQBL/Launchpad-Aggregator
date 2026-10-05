import type { Pool } from 'pg';
import { readSafeHead } from '../../coverage/launchCoverageSql.js';
import { calculateLaunchVolume } from './calculate.js';
import { claimVolumeJobs, publishVolumeScore, releaseVolumeClaim, scheduleLaunchVolumeExpiry } from './store.js';

const RETRY_DELAY_MS = 30_000;

export interface WorkerReport { claimed: number; published: number; superseded: number; failed: number }

export async function refreshDueLaunchVolumes(
  pool: Pool, now: Date, limit: number, readHead: () => Promise<bigint | null> = () => readSafeHead(pool),
): Promise<WorkerReport> {
  const report: WorkerReport = { claimed: 0, published: 0, superseded: 0, failed: 0 };
  // Read the head before claiming so a failing head read never leaves leases behind.
  const headBlock = await readHead();
  const claims = await claimVolumeJobs(pool, now, limit);
  report.claimed = claims.length;
  if (claims.length === 0) return report;

  const windowEnd = Math.floor(now.getTime() / 1000);
  for (const claim of claims) {
    try {
      const score = await calculateLaunchVolume(pool, claim.key, windowEnd, headBlock);
      if (await publishVolumeScore(pool, claim, score)) {
        report.published += 1;
        if (score.nextExpiryAt) await scheduleLaunchVolumeExpiry(pool, claim.key, score.nextExpiryAt);
      } else {
        report.superseded += 1;
      }
    } catch (error) {
      report.failed += 1;
      await releaseVolumeClaim(pool, claim, new Date(now.getTime() + RETRY_DELAY_MS), error instanceof Error ? error.message : String(error));
    }
  }
  return report;
}

// Catches work the event path can miss: an expiry whose scheduled job was lost, and an
// 'updating' row whose invalidation job was lost in a crash. Existing pending jobs keep their claim.
export async function sweepLaunchVolumes(pool: Pool, now: Date): Promise<number> {
  const result = await pool.query(`
    INSERT INTO launch_volume24h_jobs (chain_id, token_address, revision, due_at)
    SELECT s.chain_id, s.token_address, 1, $1::timestamptz FROM launch_volume24h_usd s
    WHERE (s.next_expiry_at IS NOT NULL AND s.next_expiry_at <= $1::timestamptz) OR s.completeness_reason = 'updating'
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      due_at = LEAST(launch_volume24h_jobs.due_at, EXCLUDED.due_at),
      updated_at = now()`, [now]);
  return result.rowCount ?? 0;
}
