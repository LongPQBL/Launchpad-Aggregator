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

// Corrected: the ranking used to require every launch to be scored at least once before serving
// any page at all, so a single not-yet-scored launch blocked the entire default (volume-sorted)
// view — including on a fresh/local DB where the backfill can take hours. readVolumeRankingPage's
// INNER JOIN already only returns launches with a score row, so an in-progress backfill simply
// produces an honest, growing top-N (never a fabricated zero for an unscored launch) — there is
// nothing dishonest about serving it early. Only a dead/never-run worker (no heartbeat, or a stale
// one) is still rejected, since a frozen ranking would look live.
export async function assertVolumeRankingAvailable(pool: Pool, now: Date): Promise<void> {
  const result = await pool.query('SELECT worker_heartbeat_at FROM launch_volume24h_state WHERE id = 1');
  const row = result.rows[0] as { worker_heartbeat_at: Date | null } | undefined;
  if (!row?.worker_heartbeat_at || now.getTime() - row.worker_heartbeat_at.getTime() > VOLUME_HEARTBEAT_MAX_AGE_MS) {
    throw new VolumeRankingUnavailableError('Launch volume worker heartbeat is stale');
  }
}
