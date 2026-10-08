import type { Pool } from 'pg';
import { launchCoverageSql } from '../coverage/launchCoverageSql.js';
import { decodeMetricCursor, encodeMetricCursor, type LaunchSort, type SortDirection } from './metricCursor.js';

export interface MetricRankingInput {
  sort: LaunchSort;
  direction: SortDirection;
  chainId?: number | number[];
  platform?: string | string[];
  status?: string;
  search?: string;
  cursor?: string;
  limit: number;
  headBlock: bigint | null;
  since: number;
}

const SORT_VALUES: Record<LaunchSort, string> = {
  recent: 'base.block_number::numeric',
  volume24hUsd: 'base.volume_usd',
  fdvUsd: "CASE WHEN base.launch_coverage_complete THEN (base.cached_stats->>'fdvUsd')::numeric END",
  tvlUsd: "(base.cached_stats->>'tvlUsd')::numeric",
  change1h: "CASE WHEN base.launch_coverage_complete THEN (base.cached_stats->>'change1h')::numeric END",
  change1d: "CASE WHEN base.launch_coverage_complete THEN (base.cached_stats->>'change1d')::numeric END",
};

export async function readMetricRankingPage(pool: Pool, input: MetricRankingInput): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
  const offset = input.cursor ? decodeMetricCursor(input.cursor, input.sort, input.direction).offset : 0;
  // Age increases as the launch block gets older, so its display direction is the reverse of block order.
  const sqlDirection = input.sort === 'recent'
    ? input.direction === 'asc' ? 'DESC' : 'ASC'
    : input.direction === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(`
    WITH base AS (
      SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
        st.stats AS cached_stats, vr.volume_usd, vr.rank_category, vr.window_end,
        (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
         WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
           AND t.timestamp >= $5) AS official_volume_raw,
        ${launchCoverageSql(6)} AS launch_coverage_complete
      FROM launches l
      JOIN sources src ON src.id = l.source_id
      LEFT JOIN launch_stats st ON st.chain_id = l.chain_id AND st.token_address = l.token_address
      LEFT JOIN launch_volume24h_usd vr ON vr.chain_id = l.chain_id AND vr.token_address = l.token_address
      WHERE ($1::integer[] IS NULL OR l.chain_id = ANY($1))
        AND ($2::text[] IS NULL OR l.platform = ANY($2))
        AND ($3::text IS NULL OR l.lifecycle_status = $3)
        AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.symbol ILIKE '%' || $4 || '%')
    )
    SELECT base.* FROM base
    ORDER BY ${SORT_VALUES[input.sort]} ${sqlDirection} NULLS LAST,
      base.block_number DESC, base.tx_hash DESC, base.log_index DESC
    LIMIT $7 OFFSET $8`,
  [input.chainId === undefined ? null : [input.chainId].flat(), input.platform === undefined ? null : [input.platform].flat(),
    input.status ?? null, input.search ?? null, input.since, input.headBlock?.toString() ?? null, input.limit + 1, offset]);
  const rows = result.rows.slice(0, input.limit) as Record<string, unknown>[];
  const nextCursor = result.rows.length > input.limit
    ? encodeMetricCursor({ version: 1, sort: input.sort, direction: input.direction, offset: offset + input.limit }) : null;
  return { rows, nextCursor };
}
