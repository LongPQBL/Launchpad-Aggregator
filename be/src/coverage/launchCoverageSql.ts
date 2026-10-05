import type { Pool } from 'pg';

export const SAFE_HEAD_SQL = `SELECT GREATEST(
  (SELECT max(number) FROM observed_blocks WHERE chain_id = 4663),
  (SELECT head_block FROM envio_chain_progress WHERE chain_id = 4663)
) AS safe_head`;

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
      AND coalesce(bool_and(src.confirmed_to_block >= $${headParamIndex}::bigint), false)
    FROM (
      SELECT l.source_id AS id
      UNION ALL SELECT 'pons-v2-lifecycle' WHERE l.protocol_version = 'v2'
      UNION ALL SELECT CASE v.kind
          WHEN 'v4_pool' THEN 'pons-v2-v4:' || v.ref
          WHEN 'curve' THEN 'pons-v2-curve'
          WHEN 'v3_pool' THEN l.source_id || '-trades'
        END AS id
      FROM venues v WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
    ) req
    LEFT JOIN sources src ON src.id = req.id
  )`;
}
