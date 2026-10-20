import type { Pool } from 'pg';
import { launchCoverageSql, readSafeHead } from '../coverage/launchCoverageSql.js';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { computeStats } from './store.js';
import { writeLaunchStats } from './launchStatsStore.js';

export const LAUNCH_STATS_MAX_AGE_SECONDS = 300;
// A launch nobody traded since its stats were computed is recomputed only this often: the figures that can move without a trade (a pool's TVL after a
// liquidity change) are not worth re-reading every five minutes for thousands of idle launches, which kept the database at several hundred percent.
export const LAUNCH_STATS_IDLE_MAX_AGE_SECONDS = 1800;

// Recomputes the RPC-backed figures for the launches whose stats are missing or older than the max age,
// by 24 h volume (the launches at the top of the list first), then the stalest first. The list and detail pages only read the stored result.
export async function refreshLaunchStatsOnce(pool: Pool, rpcClient: UsdPriceClient, limit: number, now: Date,
  concurrency = 1): Promise<number> {
  const head = await readSafeHead(pool);
  const staleBefore = new Date(now.getTime() - LAUNCH_STATS_MAX_AGE_SECONDS * 1000);
  const idleBefore = new Date(now.getTime() - LAUNCH_STATS_IDLE_MAX_AGE_SECONDS * 1000);
  const tradedSince = `EXISTS (SELECT 1 FROM trades t WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address
    AND t.timestamp > extract(epoch FROM s.computed_at)::bigint)`;
  const columns = `l.*, s.computed_at AS stats_computed_at, ${launchCoverageSql(1)} AS launch_coverage_complete`;
  // Only launches whose coverage is complete are picked: computeStats refuses the rest, and while the venue trade source trails the safe head (the
// lane is down, Envio is behind) the newest launches stay incomplete, so picking them anyway refilled the "never computed" quota with the same
// rows on every pass and no older launch ever got its turn ("refreshed 0" for hours, 170 launches without stats).
  // Three small passes, each ending at `limit` rows in all (one query ordering every launch by volume read the whole table, 10 s under load):
  // the due launches at the top of the volume ranking, then the stalest stored figures, then the newest launches never computed.
  // Each group gets a share of the batch: the top of the ranking alone (refreshed again every 5 minutes) used to fill all of it, so launches
  // that had never been computed waited behind it indefinitely.
  const topQuota = Math.ceil(limit / 2);
  const newQuota = Math.ceil(limit / 4);
  const rows: Record<string, unknown>[] = [];
  const taken = () => rows.map((row) => `${row.chain_id}:${row.token_address}`);
  rows.push(...(await pool.query(`
    SELECT ${columns}
    FROM (SELECT chain_id, token_address, row_number() OVER (ORDER BY rank_order ASC, volume_usd DESC NULLS LAST) AS rn
          FROM launch_volume24h_usd WHERE chain_id = 4663 AND rank_order <= 1 ORDER BY rank_order ASC, volume_usd DESC NULLS LAST LIMIT 1000) r
    JOIN launches l ON l.chain_id = r.chain_id AND l.token_address = r.token_address
    LEFT JOIN launch_stats s ON s.chain_id = l.chain_id AND s.token_address = l.token_address
    WHERE (s.computed_at IS NULL OR s.refresh_requested_at IS NOT NULL
      OR (s.computed_at < $2 AND (s.computed_at < $4 OR ${tradedSince})))
      AND ${launchCoverageSql(1)}
    ORDER BY (s.refresh_requested_at IS NULL), r.rn LIMIT $3`, [head?.toString() ?? null, staleBefore, topQuota, idleBefore])).rows);
  const newSlots = Math.min(limit - rows.length, newQuota);
  if (newSlots > 0) {
    rows.push(...(await pool.query(`
      SELECT ${columns}
      FROM launches l
      LEFT JOIN launch_stats s ON s.chain_id = l.chain_id AND s.token_address = l.token_address
      WHERE l.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM launch_stats s WHERE s.chain_id = l.chain_id AND s.token_address = l.token_address)
        AND (l.chain_id::text || ':' || l.token_address) <> ALL($3::text[])
        AND ${launchCoverageSql(1)}
      ORDER BY l.launch_block DESC LIMIT $2`, [head?.toString() ?? null, newSlots, taken()])).rows);
  }
  if (rows.length < limit) {
    rows.push(...(await pool.query(`
      SELECT ${columns}
      FROM launch_stats s JOIN launches l ON l.chain_id = s.chain_id AND l.token_address = s.token_address
      WHERE s.chain_id = 4663 AND (s.refresh_requested_at IS NOT NULL OR (s.computed_at < $2 AND (s.computed_at < $5 OR ${tradedSince})))
        AND (l.chain_id::text || ':' || l.token_address) <> ALL($4::text[])
        AND ${launchCoverageSql(1)}
      ORDER BY s.refresh_requested_at ASC NULLS LAST, s.computed_at ASC LIMIT $3`, [head?.toString() ?? null, staleBefore, limit - rows.length, taken(), idleBefore])).rows);
  }
  const due = { rows };
  let next = 0;
  let refreshed = 0;
  const lane = async () => {
    while (next < due.rows.length) {
      const row = due.rows[next++];
      if (!row.launch_coverage_complete) continue;
      const startedAt = new Date();
      const stats = await computeStats(pool, rpcClient, row, row.launch_coverage_complete as boolean);
      await writeLaunchStats(pool, Number(row.chain_id), String(row.token_address), stats, new Date(), startedAt);
      refreshed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.rows.length) }, lane));
  return refreshed;
}

// Recomputes one launch's stored figures right away (used when a trade for it was just announced). Returns false when
// the launch does not exist (for example, it was removed by reorg repair).
export async function recomputeLaunchStats(pool: Pool, rpcClient: UsdPriceClient, chainId: number, tokenAddress: string,
  now: Date = new Date()): Promise<boolean> {
  const startedAt = new Date();
  const head = await readSafeHead(pool);
  const found = await pool.query(`
    SELECT l.*, s.computed_at AS stats_computed_at, ${launchCoverageSql(1)} AS launch_coverage_complete
    FROM launches l LEFT JOIN launch_stats s ON s.chain_id = l.chain_id AND s.token_address = l.token_address
    WHERE l.chain_id = $2 AND l.token_address = $3`, [head?.toString() ?? null, chainId, tokenAddress.toLowerCase()]);
  const row = found.rows[0];
  if (!row) return false;
  if (!row.launch_coverage_complete) return true;
  const stats = await computeStats(pool, rpcClient, row, row.launch_coverage_complete as boolean);
  await writeLaunchStats(pool, chainId, String(row.token_address), stats, now, startedAt);
  return true;
}
