import type { Pool } from 'pg';

export const VOLUME_HEARTBEAT_MAX_AGE_MS = 120_000;

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

// The volume ranking is served only when every launch has been scored at least once and the worker
// is demonstrably running; otherwise a frozen or partial ranking would look like a real one.
export async function assertVolumeRankingAvailable(pool: Pool, now: Date): Promise<void> {
  const result = await pool.query('SELECT backfill_complete_at, worker_heartbeat_at FROM launch_volume24h_state WHERE id = 1');
  const row = result.rows[0] as { backfill_complete_at: Date | null; worker_heartbeat_at: Date | null } | undefined;
  if (!row?.backfill_complete_at) throw new VolumeRankingUnavailableError('Launch volume ranking backfill is not complete');
  if (!row.worker_heartbeat_at || now.getTime() - row.worker_heartbeat_at.getTime() > VOLUME_HEARTBEAT_MAX_AGE_MS) {
    throw new VolumeRankingUnavailableError('Launch volume worker heartbeat is stale');
  }
}
