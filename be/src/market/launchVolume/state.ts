import type { Pool } from 'pg';

export const VOLUME_HEARTBEAT_MAX_AGE_MS = 120_000;
// A stopped worker must not take the default (volume-sorted) home page down with it: the stored scores
// are a 24h figure that was correct when computed, and every item already carries its own
// officialVolume24hUsdAsOf. Past this age the ranking no longer describes the last 24h, so it is refused.
export const VOLUME_RANKING_MAX_STALE_MS = 6 * 60 * 60 * 1000;

export class VolumeRankingUnavailableError extends Error {}

export async function recordVolumeWorkerHeartbeat(pool: Pool, now: Date): Promise<void> {
  await pool.query(`
    INSERT INTO launch_volume24h_state (id, worker_heartbeat_at) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET worker_heartbeat_at = EXCLUDED.worker_heartbeat_at`, [now]);
}

export async function markVolumeBackfillComplete(pool: Pool, now: Date): Promise<void> {
  await pool.query(`
    INSERT INTO launch_volume24h_state (id, backfill_complete_at) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET backfill_complete_at = EXCLUDED.backfill_complete_at`, [now]);
}

// Only a worker that never ran, or one silent for longer than VOLUME_RANKING_MAX_STALE_MS, is rejected.
// A worker that is merely behind (between VOLUME_HEARTBEAT_MAX_AGE_MS and the maximum) still serves its
// last scores, reported as stale so the API can say how old they are. Unscored launches never get a
// fabricated zero: readVolumeRankingPage's INNER JOIN only returns launches that have a score row.
export async function assertVolumeRankingAvailable(pool: Pool, now: Date): Promise<{ ageMs: number; stale: boolean }> {
  const result = await pool.query('SELECT worker_heartbeat_at FROM launch_volume24h_state WHERE id = 1');
  const row = result.rows[0] as { worker_heartbeat_at: Date | null } | undefined;
  if (!row?.worker_heartbeat_at) throw new VolumeRankingUnavailableError('Launch volume worker has never recorded a heartbeat');
  const ageMs = Math.max(0, now.getTime() - row.worker_heartbeat_at.getTime());
  if (ageMs > VOLUME_RANKING_MAX_STALE_MS) throw new VolumeRankingUnavailableError('Launch volume worker heartbeat is too old');
  return { ageMs, stale: ageMs > VOLUME_HEARTBEAT_MAX_AGE_MS };
}
