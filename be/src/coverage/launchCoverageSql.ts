import type { Pool } from 'pg';

// A source counts as caught up when it is within COVERAGE_HEAD_TOLERANCE_BLOCKS of the head (default 0:
// exactly at the head). With a rate-limited indexer that always trails the head by a few blocks, a small
// tolerance keeps price/volume visible, the number then being as of that block instead of withheld.
const headTolerance = Number.parseInt(process.env.COVERAGE_HEAD_TOLERANCE_BLOCKS ?? '0', 10);
export const COVERAGE_HEAD_TOLERANCE_BLOCKS = Number.isSafeInteger(headTolerance) && headTolerance > 0
  ? BigInt(headTolerance) : 0n;

export const SAFE_HEAD_SQL = `SELECT GREATEST(
  (SELECT max(number) FROM observed_blocks WHERE chain_id = 4663),
  (SELECT head_block FROM envio_chain_progress WHERE chain_id = 4663)
) - ${COVERAGE_HEAD_TOLERANCE_BLOCKS} AS safe_head`;

export async function readSafeHead(pool: Pick<Pool, 'query'>): Promise<bigint | null> {
  const result = await pool.query(SAFE_HEAD_SQL);
  return result.rows[0]?.safe_head === null || result.rows[0]?.safe_head === undefined ? null : BigInt(String(result.rows[0].safe_head));
}

// Per-launch coverage, not the global chain-wide coverage: a launch's 24h volume/price/candles are
// complete only if ITS OWN factory, lifecycle (v2) and official venue trade sources are each
// certified to safe head — not every source ever discovered for the whole chain (docs/superpowers/
// specs/2026-09-30-parallel-indexer-design.md §5). The trade-source-id-from-venue-kind mapping
// mirrors getTradeSourceDefinitions()/getV4PoolSources(); update both together if either changes.
export function launchCoverageSql(headParamIndex: number): string {
  return `(
    SELECT $${headParamIndex}::bigint IS NOT NULL AND count(*) = count(src.id)
      AND coalesce(bool_and(
        src.confirmed_to_block >= $${headParamIndex}::bigint
        OR (req.venue_id IS NOT NULL
          AND lane.coverage_block >= $${headParamIndex}::bigint
          AND venue_lane.envio_bridge_block <= src.confirmed_to_block)
      ), false)
    FROM (
      SELECT l.source_id AS id, NULL::text AS venue_id
      UNION ALL SELECT 'pons-v2-lifecycle', NULL::text WHERE l.protocol_version = 'v2'
      UNION ALL SELECT v.source_id, v.id
      FROM venues v WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
    ) req
    LEFT JOIN sources src ON src.id = req.id
    LEFT JOIN fast_lane_state lane ON lane.chain_id = l.chain_id
    LEFT JOIN fast_lane_venue_coverage venue_lane
      ON venue_lane.chain_id = l.chain_id AND venue_lane.venue_id = req.venue_id
  )`;
}
