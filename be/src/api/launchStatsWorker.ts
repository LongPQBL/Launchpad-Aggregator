import type { Pool } from 'pg';
import { launchCoverageSql, readSafeHead } from '../coverage/launchCoverageSql.js';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { computeStats } from './store.js';
import { writeLaunchStats } from './launchStatsStore.js';

export const LAUNCH_STATS_MAX_AGE_SECONDS = 300;

// Recomputes the RPC-backed figures for the launches whose stats are missing or older than the max age,
// by 24 h volume (the launches at the top of the list first), then the stalest first. The list and detail pages only read the stored result.
export async function refreshLaunchStatsOnce(pool: Pool, rpcClient: UsdPriceClient, limit: number, now: Date,
  concurrency = 1): Promise<number> {
  const head = await readSafeHead(pool);
  const staleBefore = new Date(now.getTime() - LAUNCH_STATS_MAX_AGE_SECONDS * 1000);
  const columns = `l.*, ${launchCoverageSql(1)} AS launch_coverage_complete`;
  // Three small passes, each ending at `limit` rows in all (one query ordering every launch by volume read the whole table, 10 s under load):
  // the due launches at the top of the volume ranking, then the stalest stored figures, then the newest launches never computed.
  const rows: Record<string, unknown>[] = [];
  const taken = () => rows.map((row) => `${row.chain_id}:${row.token_address}`);
  rows.push(...(await pool.query(`
    SELECT ${columns}
    FROM (SELECT chain_id, token_address, row_number() OVER (ORDER BY rank_order ASC, volume_usd DESC NULLS LAST) AS rn
          FROM launch_volume24h_usd WHERE chain_id = 4663 AND rank_order <= 1 ORDER BY rank_order ASC, volume_usd DESC NULLS LAST LIMIT 1000) r
    JOIN launches l ON l.chain_id = r.chain_id AND l.token_address = r.token_address
    LEFT JOIN launch_stats s ON s.chain_id = l.chain_id AND s.token_address = l.token_address
    WHERE s.computed_at IS NULL OR s.computed_at < $2
    ORDER BY r.rn LIMIT $3`, [head?.toString() ?? null, staleBefore, limit])).rows);
  if (rows.length < limit) {
    rows.push(...(await pool.query(`
      SELECT ${columns}
      FROM launch_stats s JOIN launches l ON l.chain_id = s.chain_id AND l.token_address = s.token_address
      WHERE s.chain_id = 4663 AND s.computed_at < $2 AND (l.chain_id::text || ':' || l.token_address) <> ALL($4::text[])
      ORDER BY s.computed_at ASC LIMIT $3`, [head?.toString() ?? null, staleBefore, limit - rows.length, taken()])).rows);
  }
  if (rows.length < limit) {
    rows.push(...(await pool.query(`
      SELECT ${columns}
      FROM launches l
      WHERE l.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM launch_stats s WHERE s.chain_id = l.chain_id AND s.token_address = l.token_address)
        AND (l.chain_id::text || ':' || l.token_address) <> ALL($3::text[])
      ORDER BY l.launch_block DESC LIMIT $2`, [head?.toString() ?? null, limit - rows.length, taken()])).rows);
  }
  const due = { rows };
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

// Recomputes one launch's stored figures right away (used when a trade for it was just announced). Returns false when
// the launch does not exist (for example, it was removed by reorg repair).
export async function recomputeLaunchStats(pool: Pool, rpcClient: UsdPriceClient, chainId: number, tokenAddress: string,
  now: Date = new Date()): Promise<boolean> {
  const head = await readSafeHead(pool);
  const found = await pool.query(`
    SELECT l.*, ${launchCoverageSql(1)} AS launch_coverage_complete
    FROM launches l WHERE l.chain_id = $2 AND l.token_address = $3`, [head?.toString() ?? null, chainId, tokenAddress.toLowerCase()]);
  const row = found.rows[0];
  if (!row) return false;
  const stats = await computeStats(pool, rpcClient, row, Boolean(row.launch_coverage_complete));
  await writeLaunchStats(pool, chainId, String(row.token_address), stats, now);
  return true;
}
