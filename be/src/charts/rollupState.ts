import type { Pool } from 'pg';

export type RollupName = 'launch_volume' | 'pool_volume' | 'launch_usd_candles';

// The volume rollups only describe history once the backfill has covered it; until then a bucket with no row could be
// an unprocessed day, not a real zero, so the readers report the series as incomplete.
export async function isRollupBackfilled(pool: Pool, name: RollupName): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM chart_rollup_state WHERE name = $1', [`${name}_done`]);
  return result.rowCount === 1;
}

export async function markRollupBackfilled(pool: Pool, name: RollupName): Promise<void> {
  await pool.query(`INSERT INTO chart_rollup_state (name, completed_through) VALUES ($1, 1)
    ON CONFLICT (name) DO UPDATE SET completed_through = 1`, [`${name}_done`]);
}
