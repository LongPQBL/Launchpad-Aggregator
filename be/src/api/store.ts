import type { Pool } from 'pg';
import { formatUnits, type Address, type Hash } from 'viem';
import type { Trade } from '../domain/types.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { formatRational } from '../market/price.js';
import { buildOfficialCandles } from '../market/aggregate.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { ApiDeps, CandleResponse, LaunchDetail, LaunchSummary, ListQuery, Page, TradeResponse } from './server.js';

type Row = Record<string, unknown>;
const baseSourceIds = [...getPonsFactorySources().map((source) => source.id),
  'pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];

function string(value: unknown): string { return String(value); }
function number(value: unknown): number { return Number(value); }

function summary(row: Row, coverageStatus: string): LaunchSummary {
  return {
    chainId: number(row.chain_id), tokenAddress: string(row.token_address), name: string(row.name), symbol: string(row.symbol),
    platform: string(row.platform), protocolVersion: string(row.protocol_version),
    quoteAsset: { address: string(row.quote_asset_address), symbol: string(row.quote_asset_symbol), decimals: number(row.quote_asset_decimals) },
    lifecycleStatus: string(row.lifecycle_status),
    officialVolume24h: coverageStatus === 'caught_up' && row.official_volume_raw !== undefined
      ? formatUnits(BigInt(string(row.official_volume_raw)), number(row.quote_asset_decimals)) : null,
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
    const [sourceResult, headResult, gapResult, poolResult, phaseResult] = await Promise.all([
      pool.query('SELECT id, status, confirmed_to_block, start_block FROM sources'),
      pool.query('SELECT max(number) AS safe_head FROM observed_blocks WHERE chain_id = 4663'),
      pool.query('SELECT source_id, from_block, to_block, reason FROM source_gaps ORDER BY source_id, from_block'),
      pool.query("SELECT DISTINCT 'pons-v2-v4:' || lower(ref) AS id FROM venues WHERE chain_id = 4663 AND kind = 'v4_pool' AND official = true"),
      pool.query(`SELECT count(*)::int AS count FROM launches l LEFT JOIN phase_observations p
        ON p.chain_id = l.chain_id AND p.token_address = l.token_address
        WHERE l.chain_id = 4663 AND l.protocol_version = 'v2' AND p.status IS DISTINCT FROM 'verified'`),
    ]);
    const requiredSourceIds = [...baseSourceIds, ...poolResult.rows.map((row: Row) => string(row.id))];
    const head = headResult.rows[0]?.safe_head === null ? null : BigInt(string(headResult.rows[0].safe_head));
    const byId = new Map(sourceResult.rows.map((row: Row) => [string(row.id), row]));
    const pendingSourceIds = requiredSourceIds.filter((id) => {
      const row = byId.get(id);
      return !row || head === null || row.status !== 'caught_up'
        || (BigInt(string(row.start_block)) <= head && BigInt(string(row.confirmed_to_block)) < head);
    });
    const missingRanges = gapResult.rows.filter((row: Row) => requiredSourceIds.includes(string(row.source_id)))
      .map((row: Row) => ({ sourceId: string(row.source_id),
      fromBlock: string(row.from_block), toBlock: string(row.to_block), reason: string(row.reason) }));
    if (number(phaseResult.rows[0]?.count) > 0) pendingSourceIds.push('pons-v2-phase');
    return { complete: pendingSourceIds.length === 0 && missingRanges.length === 0, pendingSourceIds, missingRanges };
  }
  return {
    async listSources() {
      const result = await pool.query('SELECT id, chain_id, version FROM sources ORDER BY id');
      return result.rows.filter((row: Row) => baseSourceIds.includes(string(row.id)) || string(row.id).startsWith('pons-v2-v4:'))
        .map((row: Row) => ({ id: string(row.id), chainId: number(row.chain_id), platform: 'pons', protocolVersion: string(row.version) }));
    },
    getCoverage: coverage,
    async listLaunches(query: ListQuery) {
      const status = await coverage();
      const coverageStatus = status.complete ? 'caught_up' : 'backfilling';
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const result = await pool.query(`
        SELECT l.*, s.status AS source_status, r.block_number, r.tx_hash, r.log_index,
          (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
           WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
             AND t.timestamp >= $6) AS official_volume_raw
        FROM launches l JOIN sources s ON s.id = l.source_id JOIN raw_logs r ON r.id = l.source_log_id
        WHERE ($1::integer IS NULL OR l.chain_id = $1)
          AND ($2::bigint IS NULL OR (r.block_number, r.tx_hash, r.log_index) < ($2::bigint, $3::text, $4::integer))
        ORDER BY r.block_number DESC, r.tx_hash DESC, r.log_index DESC LIMIT $5`,
      [query.chainId ?? null, cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null, cursor?.logIndex ?? null, query.limit + 1, since]);
      return page(result.rows as Row[], query.limit, (row) => summary(row, coverageStatus));
    },
    async getLaunch(chainId: number, tokenAddress: string): Promise<LaunchDetail | null> {
      const status = await coverage();
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const result = await pool.query(`SELECT l.*, s.status AS source_status,
        (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
         WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
           AND t.timestamp >= $3) AS official_volume_raw
        FROM launches l JOIN sources s ON s.id = l.source_id
        WHERE l.chain_id = $1 AND l.token_address = $2 LIMIT 1`, [chainId, tokenAddress.toLowerCase(), since]);
      const row = result.rows[0] as Row | undefined;
      if (!row) return null;
      const venueRows = await pool.query(`SELECT id, kind, ref, effective_from_block, effective_to_block FROM venues
        WHERE chain_id = $1 AND token_address = $2 AND official = true ORDER BY effective_from_block`, [chainId, tokenAddress.toLowerCase()]);
      const lastPrice = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, v.kind AS venue_kind FROM trades t
        JOIN venues v ON v.id = t.venue_id WHERE t.chain_id = $1 AND t.token_address = $2
        AND v.official = true AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`, [chainId, tokenAddress.toLowerCase()]);
      const priced = lastPrice.rows[0] as Row | undefined;
      return { ...summary(row, status.complete ? 'caught_up' : 'backfilling'), officialVenues: venueRows.rows.map((venue: Row) => ({
        id: string(venue.id), kind: string(venue.kind), ref: string(venue.ref),
        effectiveFromBlock: string(venue.effective_from_block),
        effectiveToBlock: venue.effective_to_block === null ? null : string(venue.effective_to_block),
      })), priceQuote: status.complete && priced
        ? formatRational(BigInt(string(priced.price_numerator_raw)), BigInt(string(priced.price_denominator_raw)), 18) : null,
      priceStale: row.protocol_version === 'v2' && row.lifecycle_status !== 'trading'
        && (row.lifecycle_status !== 'graduated' || priced?.venue_kind !== 'v4_pool') };
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
    async listCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number): Promise<{ items: readonly CandleResponse[]; complete: boolean }> {
      const launchResult = await pool.query(`SELECT quote_asset_address, quote_asset_decimals FROM launches
        WHERE chain_id = $1 AND token_address = $2 LIMIT 1`, [chainId, tokenAddress.toLowerCase()]);
      const launch = launchResult.rows[0] as Row | undefined;
      if (!launch) return { items: [], complete: false };
      const end = before ?? Math.floor(Date.now() / 1000) + 1;
      const start = Math.floor((end - 1) / intervalSeconds) * intervalSeconds - 499 * intervalSeconds;
      const result = await pool.query(`SELECT t.* FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
          AND t.timestamp >= $3 AND t.timestamp < $4
        ORDER BY t.block_number, t.log_index`, [chainId, tokenAddress.toLowerCase(), start, end]);
      const rows = result.rows as Row[];
      const mapped: Trade[] = rows.map((row) => ({ chainId, tokenAddress: tokenAddress.toLowerCase() as Address,
        venueId: string(row.venue_id), blockNumber: BigInt(string(row.block_number)), blockHash: string(row.block_hash) as Hash,
        txHash: string(row.tx_hash) as Hash, logIndex: number(row.log_index), timestamp: number(row.timestamp),
        side: string(row.side) as Trade['side'], tokenAmountRaw: BigInt(string(row.token_amount_raw)),
        quoteAmountRaw: BigInt(string(row.quote_amount_raw)), quoteAssetAddress: string(row.quote_asset_address) as Address,
        sourceEvent: string(row.source_event), activityKind: string(row.activity_kind) as Trade['activityKind'],
        priceNumeratorRaw: row.price_numerator_raw === null ? null : BigInt(string(row.price_numerator_raw)),
        priceDenominatorRaw: row.price_denominator_raw === null ? null : BigInt(string(row.price_denominator_raw)),
      }));
      const candles = buildOfficialCandles(mapped, intervalSeconds, { chainId, tokenAddress: tokenAddress.toLowerCase() as Address,
        quoteAssetAddress: string(launch.quote_asset_address) as Address,
        venueIds: new Set(rows.map((row) => string(row.venue_id))), complete: true });
      return { complete: (await coverage()).complete && !rows.some((row) => row.price_numerator_raw === null || row.price_denominator_raw === null),
        items: candles.reverse().map((candle) => ({ intervalSeconds, bucketStart: candle.bucketStart,
        open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        quoteVolume: formatUnits(candle.quoteVolumeRaw, number(launch.quote_asset_decimals)),
      })) };
    },
  };
}
