import type { Pool } from 'pg';
import { launchCoverageSql, readSafeHead } from '../coverage/launchCoverageSql.js';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { computeStats } from './store.js';
import { writeLaunchStats } from './launchStatsStore.js';

export const LAUNCH_STATS_MAX_AGE_SECONDS = 300;

// Recomputes the RPC-backed figures for the launches whose stats are missing or older than the max age,
// oldest first. The list and detail pages only read the stored result.
export async function refreshLaunchStatsOnce(pool: Pool, rpcClient: UsdPriceClient, limit: number, now: Date,
  concurrency = 1): Promise<number> {
  const head = await readSafeHead(pool);
  const due = await pool.query(`
    SELECT l.*, ${launchCoverageSql(1)} AS launch_coverage_complete
    FROM launches l LEFT JOIN launch_stats s ON s.chain_id = l.chain_id AND s.token_address = l.token_address
    WHERE l.chain_id = 4663 AND (s.computed_at IS NULL OR s.computed_at < $2)
    ORDER BY s.computed_at ASC NULLS FIRST, l.launch_block DESC
    LIMIT $3`, [head?.toString() ?? null, new Date(now.getTime() - LAUNCH_STATS_MAX_AGE_SECONDS * 1000), limit]);
  let next = 0;
  const lane = async () => {
    while (next < due.rows.length) {
      const row = due.rows[next++];
      const stats = await computeStats(pool, rpcClient, row, Boolean(row.launch_coverage_complete));
      await writeLaunchStats(pool, Number(row.chain_id), String(row.token_address), stats, new Date());
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.rows.length) }, lane));
  return due.rows.length;
}
