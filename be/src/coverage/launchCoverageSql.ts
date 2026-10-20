import type { Pool } from 'pg';

// A source counts as caught up when it is within COVERAGE_HEAD_TOLERANCE_BLOCKS of the head (default 0:
// exactly at the head). With a rate-limited indexer that always trails the head by a few blocks, a small
// tolerance keeps price/volume visible, the number then being as of that block instead of withheld.
const headTolerance = Number.parseInt(process.env.COVERAGE_HEAD_TOLERANCE_BLOCKS ?? '0', 10);
export const COVERAGE_HEAD_TOLERANCE_BLOCKS = Number.isSafeInteger(headTolerance) && headTolerance > 0
  ? BigInt(headTolerance) : 0n;

// The factory (launch) and lifecycle sources carry a launch's existence and phase, not its trades, and a trade is covered by the fast lane once Envio
// has handed over. So they may trail the head by this much more than a trade stream before a launch counts as incomplete: it keeps prices, volumes and
// stats from freezing for as long as the indexer is held back by the provider's rate limit, yet still flags a source that is hours behind.
const factoryTolerance = Number.parseInt(process.env.COVERAGE_FACTORY_TOLERANCE_BLOCKS ?? '50000', 10);
export const COVERAGE_FACTORY_TOLERANCE_BLOCKS = Number.isSafeInteger(factoryTolerance) && factoryTolerance > 0 ? factoryTolerance : 0;

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
export function launchCoverageSql(headParamIndex: number, options: { tradesOnly?: boolean; factoryToleranceBlocks?: number } = {}): string {
  const tolerance = options.factoryToleranceBlocks ?? COVERAGE_FACTORY_TOLERANCE_BLOCKS;
  // `tradesOnly`: only the official venue's trade stream has to be current, not the factory or lifecycle source. For a chart of one venue's trades
  // those two cannot change a bucket: a trade-free bucket there really is $0, where waiting on them left every empty bucket "unavailable" for as long as
  // Envio trailed the head (the trades themselves are covered by the fast lane).
  const sources = options.tradesOnly
    ? `SELECT v.source_id AS id, v.id AS venue_id
      FROM venues v WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true`
    : `SELECT l.source_id AS id, NULL::text AS venue_id
      UNION ALL SELECT 'pons-v2-lifecycle', NULL::text WHERE l.protocol_version = 'v2'
      UNION ALL SELECT v.source_id, v.id
      FROM venues v WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true`;
  return `(
    SELECT $${headParamIndex}::bigint IS NOT NULL AND count(*) = count(src.id)
      AND coalesce(bool_and(
        src.confirmed_to_block >= $${headParamIndex}::bigint - (CASE WHEN req.venue_id IS NULL THEN ${tolerance} ELSE 0 END)
        OR (req.venue_id IS NOT NULL
          AND lane.coverage_block >= $${headParamIndex}::bigint
          AND venue_lane.envio_bridge_block <= src.confirmed_to_block)
      ), false)
    FROM (
      ${sources}
    ) req
    LEFT JOIN sources src ON src.id = req.id
    LEFT JOIN fast_lane_state lane ON lane.chain_id = l.chain_id
    LEFT JOIN fast_lane_venue_coverage venue_lane
      ON venue_lane.chain_id = l.chain_id AND venue_lane.venue_id = req.venue_id
  )`;
}
