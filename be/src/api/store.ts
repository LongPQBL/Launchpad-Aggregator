import type { Pool } from 'pg';
import { formatUnits } from 'viem';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { formatRational } from '../market/price.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { ApiDeps, CandleResponse, LaunchDetail, LaunchSummary, ListQuery, Page, TradeResponse } from './server.js';

type Row = Record<string, unknown>;
const requiredSourceIds = [...getPonsFactorySources().map((source) => source.id), 'pons-v1-trades', 'pons-v2-curve', 'pons-v2-v4'];

function string(value: unknown): string { return String(value); }
function number(value: unknown): number { return Number(value); }

function summary(row: Row, coverageStatus: string): LaunchSummary {
  return {
    chainId: number(row.chain_id), tokenAddress: string(row.token_address), name: string(row.name), symbol: string(row.symbol),
    platform: string(row.platform), protocolVersion: string(row.protocol_version),
    quoteAsset: { address: string(row.quote_asset_address), symbol: string(row.quote_asset_symbol), decimals: number(row.quote_asset_decimals) },
    lifecycleStatus: string(row.lifecycle_status), officialVolume24h: null,
    coverageStatus,
  };
}

function page<T>(rows: readonly Row[], limit: number, map: (row: Row) => T): Page<T> {
  const included = rows.slice(0, limit);
  const last = included.at(-1);
  return { items: included.map(map), nextCursor: rows.length > limit && last ? encodeCursor({
    blockNumber: BigInt(string(last.block_number)), txHash: string(last.tx_hash), logIndex: number(last.log_index),
  }) : null };
}

export function createApiStore(pool: Pool): ApiDeps['data'] {
  async function coverage() {
    const [sourceResult, headResult] = await Promise.all([
      pool.query('SELECT id, status, confirmed_to_block, start_block FROM sources'),
      pool.query('SELECT max(number) AS safe_head FROM observed_blocks WHERE chain_id = 4663'),
    ]);
    const head = headResult.rows[0]?.safe_head === null ? null : BigInt(string(headResult.rows[0].safe_head));
    const byId = new Map(sourceResult.rows.map((row: Row) => [string(row.id), row]));
    const pendingSourceIds = requiredSourceIds.filter((id) => {
      const row = byId.get(id);
      return !row || head === null || row.status !== 'caught_up'
        || (BigInt(string(row.start_block)) <= head && BigInt(string(row.confirmed_to_block)) < head);
    });
    return { complete: pendingSourceIds.length === 0, pendingSourceIds, missingRanges: [] };
  }
  return {
    async listSources() {
      const result = await pool.query('SELECT id, chain_id, version FROM sources ORDER BY id');
      return result.rows.map((row: Row) => ({ id: string(row.id), chainId: number(row.chain_id), platform: 'pons', protocolVersion: string(row.version) }));
    },
    getCoverage: coverage,
    async listLaunches(query: ListQuery) {
      const status = await coverage();
      const coverageStatus = status.complete ? 'caught_up' : 'backfilling';
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const result = await pool.query(`
        SELECT l.*, s.status AS source_status, r.block_number, r.tx_hash, r.log_index
        FROM launches l JOIN sources s ON s.id = l.source_id JOIN raw_logs r ON r.id = l.source_log_id
        WHERE ($1::integer IS NULL OR l.chain_id = $1)
          AND ($2::bigint IS NULL OR (r.block_number, r.tx_hash, r.log_index) < ($2::bigint, $3::text, $4::integer))
        ORDER BY r.block_number DESC, r.tx_hash DESC, r.log_index DESC LIMIT $5`,
      [query.chainId ?? null, cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null, cursor?.logIndex ?? null, query.limit + 1]);
      return page(result.rows as Row[], query.limit, (row) => summary(row, coverageStatus));
    },
    async getLaunch(chainId: number, tokenAddress: string): Promise<LaunchDetail | null> {
      const status = await coverage();
      const result = await pool.query(`SELECT l.*, s.status AS source_status FROM launches l JOIN sources s ON s.id = l.source_id
        WHERE l.chain_id = $1 AND l.token_address = $2 LIMIT 1`, [chainId, tokenAddress.toLowerCase()]);
      const row = result.rows[0] as Row | undefined;
      if (!row) return null;
      const venueRows = await pool.query(`SELECT id, kind, ref, effective_from_block, effective_to_block FROM venues
        WHERE chain_id = $1 AND token_address = $2 AND official = true ORDER BY effective_from_block`, [chainId, tokenAddress.toLowerCase()]);
      return { ...summary(row, status.complete ? 'caught_up' : 'backfilling'), officialVenues: venueRows.rows.map((venue: Row) => ({
        id: string(venue.id), kind: string(venue.kind), ref: string(venue.ref),
        effectiveFromBlock: string(venue.effective_from_block),
        effectiveToBlock: venue.effective_to_block === null ? null : string(venue.effective_to_block),
      })), priceQuote: null };
    },
    async listTrades(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TradeResponse>> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const result = await pool.query(`SELECT t.*, l.token_decimals, l.quote_asset_decimals
        FROM trades t JOIN venues v ON v.id = t.venue_id
        JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
          AND ($3::bigint IS NULL OR (t.block_number, t.tx_hash, t.log_index) < ($3::bigint, $4::text, $5::integer))
        ORDER BY t.block_number DESC, t.tx_hash DESC, t.log_index DESC LIMIT $6`,
      [chainId, tokenAddress.toLowerCase(), cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null,
        cursor?.logIndex ?? null, query.limit + 1]);
      return page(result.rows as Row[], query.limit, (row) => ({
        venueId: string(row.venue_id), blockNumber: string(row.block_number), txHash: string(row.tx_hash),
        logIndex: number(row.log_index), timestamp: number(row.timestamp), side: string(row.side),
        activityKind: string(row.activity_kind), tokenAmount: formatUnits(BigInt(string(row.token_amount_raw)), number(row.token_decimals)),
        quoteAmount: formatUnits(BigInt(string(row.quote_amount_raw)), number(row.quote_asset_decimals)),
        priceQuote: row.price_numerator_raw === null || row.price_denominator_raw === null ? null
          : formatRational(BigInt(string(row.price_numerator_raw)), BigInt(string(row.price_denominator_raw)), 18),
      })) as Page<TradeResponse>;
    },
    async listCandles(chainId: number, tokenAddress: string, intervalSeconds: number): Promise<{ items: readonly CandleResponse[] }> {
      const result = await pool.query(`SELECT c.*, l.quote_asset_decimals FROM candles c
        JOIN launches l ON l.chain_id = c.chain_id AND l.token_address = c.token_address
        WHERE c.chain_id = $1 AND c.token_address = $2 AND c.interval_seconds = $3
        ORDER BY c.bucket_start DESC LIMIT 500`, [chainId, tokenAddress.toLowerCase(), intervalSeconds]);
      return { items: result.rows.map((row: Row) => ({ intervalSeconds: number(row.interval_seconds), bucketStart: number(row.bucket_start),
        open: string(row.open), high: string(row.high), low: string(row.low), close: string(row.close),
        quoteVolume: formatUnits(BigInt(string(row.quote_volume_raw)), number(row.quote_asset_decimals)),
      })) };
    },
  };
}
