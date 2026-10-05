import type { Pool } from 'pg';
import { launchCoverageSql } from '../../coverage/launchCoverageSql.js';
import type { RankCategory } from './store.js';

// Keyset position of the last row returned. Natural pagination: each request reads the latest published
// ranking, so a launch whose rank moved between two requests may repeat or be skipped across pages.
export interface VolumeRankCursor {
  rankOrder: 0 | 1 | 2;
  volumeUsd: string | null;
  launchBlock: string;
  launchTxHash: string;
  launchLogIndex: number;
}

export interface VolumeRankPageInput {
  chainId?: number;
  platform?: string;
  status?: string;
  search?: string;
  cursor: VolumeRankCursor | null;
  limit: number;
  headBlock: bigint | null;
}

export interface VolumeRankRow {
  raw: Record<string, unknown>;
  volumeUsd: string | null;
  rankCategory: RankCategory;
  windowEnd: number;
  coverageComplete: boolean;
}

export interface VolumeRankPage {
  rows: VolumeRankRow[];
  nextCursor: VolumeRankCursor | null;
}

function normalizeDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

export async function readVolumeRankingPage(pool: Pool, input: VolumeRankPageInput): Promise<VolumeRankPage> {
  const cursor = input.cursor;
  // The row-comparison predicate walks the same order as ORDER BY: positive volume descending, then
  // known zero, then null (rank_order 2, which has no volume and orders by recency alone).
  const result = await pool.query(`
    SELECT l.chain_id, l.token_address, l.name, l.symbol, l.platform, l.protocol_version, l.token_decimals,
      l.factory_address, l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals, l.lifecycle_status,
      l.v4_pool_fee, l.v4_tick_spacing, l.logo_uri, l.website_url, l.twitter_url, l.launch_timestamp,
      l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
      s.volume_usd, s.rank_category, s.rank_order, s.window_end,
      s.launch_block AS score_block, s.launch_tx_hash AS score_tx, s.launch_log_index AS score_log,
      ${launchCoverageSql(12)} AS launch_coverage_complete
    FROM launch_volume24h_usd s
    JOIN launches l ON l.chain_id = s.chain_id AND l.token_address = s.token_address
    WHERE ($1::integer IS NULL OR l.chain_id = $1) AND ($2::text IS NULL OR l.platform = $2)
      AND ($3::text IS NULL OR l.lifecycle_status = $3)
      AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.symbol ILIKE '%' || $4 || '%')
      AND ($5::boolean = false OR (
        s.rank_order > $6::smallint OR (s.rank_order = $6::smallint AND (
          CASE WHEN $6::smallint = 2
            THEN (s.launch_block, s.launch_tx_hash, s.launch_log_index) < ($8::bigint, $9::text, $10::integer)
            ELSE s.volume_usd < $7::numeric
              OR (s.volume_usd = $7::numeric AND (s.launch_block, s.launch_tx_hash, s.launch_log_index) < ($8::bigint, $9::text, $10::integer))
          END))))
    ORDER BY s.rank_order, s.volume_usd DESC NULLS LAST, s.launch_block DESC, s.launch_tx_hash DESC, s.launch_log_index DESC
    LIMIT $11`,
  [input.chainId ?? null, input.platform ?? null, input.status ?? null, input.search ?? null,
    cursor !== null, cursor?.rankOrder ?? 0, cursor?.volumeUsd ?? null, cursor?.launchBlock ?? null,
    cursor?.launchTxHash ?? null, cursor?.launchLogIndex ?? null, input.limit + 1, input.headBlock?.toString() ?? null]);

  const included = result.rows.slice(0, input.limit);
  const rows: VolumeRankRow[] = included.map((row) => ({
    raw: row,
    volumeUsd: normalizeDecimal(row.volume_usd),
    rankCategory: row.rank_category as RankCategory,
    windowEnd: Number(row.window_end),
    coverageComplete: Boolean(row.launch_coverage_complete),
  }));
  const last = included.at(-1);
  const nextCursor: VolumeRankCursor | null = result.rows.length > input.limit && last
    ? {
      rankOrder: Number(last.rank_order) as 0 | 1 | 2,
      volumeUsd: normalizeDecimal(last.volume_usd),
      launchBlock: String(last.score_block),
      launchTxHash: String(last.score_tx),
      launchLogIndex: Number(last.score_log),
    }
    : null;
  return { rows, nextCursor };
}
