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
  // A launch without cached stats sorts as NULL whatever its coverage is, so the (expensive) coverage check runs only for launches that have stats.
  fdvUsd: "CASE WHEN base.cached_stats IS NULL THEN NULL WHEN base.launch_coverage_complete THEN (base.cached_stats->>'fdvUsd')::numeric END",
  tvlUsd: "(base.cached_stats->>'tvlUsd')::numeric",
  change1h: "CASE WHEN base.cached_stats IS NULL THEN NULL WHEN base.launch_coverage_complete THEN (base.cached_stats->>'change1h')::numeric END",
  change1d: "CASE WHEN base.cached_stats IS NULL THEN NULL WHEN base.launch_coverage_complete THEN (base.cached_stats->>'change1d')::numeric END",
};

export async function readMetricRankingPage(pool: Pool, input: MetricRankingInput): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
  const offset = input.cursor ? decodeMetricCursor(input.cursor, input.sort, input.direction).offset : 0;
  // Age increases as the launch block gets older, so its display direction is the reverse of block order.
  const sqlDirection = input.sort === 'recent'
    ? input.direction === 'asc' ? 'DESC' : 'ASC'
    : input.direction === 'asc' ? 'ASC' : 'DESC';
  // Only launches with cached stats can have a non-NULL stat value; every other launch sorts as NULL, in recency order. So for the stat sorts the
  // launches with stats are ranked on their own (a handful of rows) and only as many of the others as the page can reach are read in recency
  // order, instead of joining, evaluating and sorting every launch.
  const statSort = input.sort === 'fdvUsd' || input.sort === 'tvlUsd' || input.sort === 'change1h' || input.sort === 'change1d';
  const volumeJoinSql = statSort ? '' : 'LEFT JOIN launch_volume24h_usd vr ON vr.chain_id = l.chain_id AND vr.token_address = l.token_address';
  const params: unknown[] = [input.chainId === undefined ? null : [input.chainId].flat(), input.platform === undefined ? null : [input.platform].flat(),
    input.status ?? null, input.search ?? null, input.since, input.headBlock?.toString() ?? null, input.limit + 1, offset,
    ...(statSort ? [input.limit + 1 + offset] : [])];
  const filters = `JOIN sources src ON src.id = l.source_id
      LEFT JOIN launch_stats st ON st.chain_id = l.chain_id AND st.token_address = l.token_address
      ${volumeJoinSql}
      WHERE ($1::integer[] IS NULL OR l.chain_id = ANY($1))
        AND ($2::text[] IS NULL OR l.platform = ANY($2))
        AND l.name IS NOT NULL AND l.symbol IS NOT NULL
        AND ($3::text IS NULL OR l.lifecycle_status = $3)
        AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.symbol ILIKE '%' || $4 || '%')`;
  const officialVolumeRaw = `(SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t
         WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND t.timestamp >= $5
           AND t.venue_id IN (SELECT v.id FROM venues v WHERE v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true)) AS official_volume_raw`;
  let result;
  if (statSort) {
    // Ranking by a stored figure must not compute, for every launch that has stats (thousands once the stats worker has covered them), the coverage check
    // (about 2 ms each) and the day's trade sum: the order needs only the stored value, so the page is picked first and only its rows get the expensive columns
    // (a fdv sort took 92 s that way). A launch whose coverage lapses after its stats were stored keeps its rank and shows no value (the page still applies the
    // coverage rule to what it displays).
    const rankValue = (alias: string) => `(${alias}.cached_stats->>'${input.sort}')::numeric`;
    result = await pool.query(`
      WITH base AS (
        (SELECT l.chain_id, l.token_address, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
            st.stats AS cached_stats
          FROM launches l ${filters} AND st.stats IS NOT NULL)
        UNION ALL
        (SELECT l.chain_id, l.token_address, l.launch_block, l.launch_tx_hash, l.launch_log_index,
            st.stats
          FROM launches l ${filters} AND st.stats IS NULL
          ORDER BY l.launch_block DESC, l.launch_tx_hash DESC, l.launch_log_index DESC LIMIT $9)
      ), page AS (
        SELECT base.* FROM base
        ORDER BY ${rankValue('base')} ${sqlDirection} NULLS LAST, base.block_number DESC, base.tx_hash DESC, base.log_index DESC
        LIMIT $7 OFFSET $8
      )
      SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
        page.cached_stats, vr.volume_usd, vr.rank_category, vr.window_end,
        ${officialVolumeRaw},
        ${launchCoverageSql(6)} AS launch_coverage_complete
      FROM page JOIN launches l ON l.chain_id = page.chain_id AND l.token_address = page.token_address
      LEFT JOIN launch_volume24h_usd vr ON vr.chain_id = l.chain_id AND vr.token_address = l.token_address
      ORDER BY ${rankValue('page')} ${sqlDirection} NULLS LAST, page.block_number DESC, page.tx_hash DESC, page.log_index DESC`, params);
  } else {
    result = await pool.query(`
      WITH base AS (SELECT l.*, l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
          st.stats AS cached_stats, vr.volume_usd, vr.rank_category, vr.window_end,
          ${officialVolumeRaw},
          ${launchCoverageSql(6)} AS launch_coverage_complete
        FROM launches l ${filters})
      SELECT base.* FROM base
      ORDER BY ${SORT_VALUES[input.sort]} ${sqlDirection} NULLS LAST,
        base.block_number DESC, base.tx_hash DESC, base.log_index DESC
      LIMIT $7 OFFSET $8`, params);
  }
  const rows = result.rows.slice(0, input.limit) as Record<string, unknown>[];
  const nextCursor = result.rows.length > input.limit
    ? encodeMetricCursor({ version: 1, sort: input.sort, direction: input.direction, offset: offset + input.limit }) : null;
  return { rows, nextCursor };
}
