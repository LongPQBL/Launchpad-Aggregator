import type { Pool } from 'pg';
import { formatUnits, type Address, type Hash } from 'viem';
import type { Trade } from '../domain/types.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { readLaunchParityCoverage } from '../coverage/repairRanges.js';
import { formatRational } from '../market/price.js';
import { buildOfficialCandles, compute52WeekHighLow, computePriceChange } from '../market/aggregate.js';
import { read52WeekHighLowFromCandles } from '../market/candleStats.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { enqueueRoundBackfillJob } from '../market/quotePricing/priceJobStore.js';
import { decodeVolumeCursor, encodeVolumeCursor, InvalidVolumeCursorError } from './volumeCursor.js';
import { computeFdvUsd, readTotalSupply } from '../market/tokenStats.js';
import { readCurrentTvl, NULL_TVL, type TvlFields } from '../market/tvlStats.js';
import type { VenueAmountInput } from '../market/tvlReserves.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { readConfirmedSourceBlock, STREAM_ORDER } from '../envioSync/incrementalSync.js';
import { readRepairState } from '../envioSync/incrementalRepair.js';
import type { ApiDeps, CandleResponse, IncrementalSyncCoverage, LaunchDetail, LaunchListQuery, LaunchSummary, ListQuery, Page, TradeResponse } from './server.js';

type Row = Record<string, unknown>;
const baseSourceIds = [...getPonsFactorySources().map((source) => source.id),
  'pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];

function string(value: unknown): string { return String(value); }
function number(value: unknown): number { return Number(value); }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }

// Per-launch coverage, not the global `coverage()` below: a launch's 24h volume/price/candles are
// complete only if ITS OWN factory, lifecycle (v2) and official venue trade sources are each
// certified to safe head — not every source ever discovered for the whole chain (docs/superpowers/
// specs/2026-09-30-parallel-indexer-design.md §5). The trade-source-id-from-venue-kind mapping
// mirrors getTradeSourceDefinitions()/getV4PoolSources(); update both together if either changes.
function launchCoverageSql(headParamIndex: number): string {
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

function summary(row: Row, complete: boolean, stats: StatsFields): LaunchSummary {
  const coverageStatus = complete ? 'caught_up' : 'backfilling';
  return {
    chainId: number(row.chain_id), tokenAddress: string(row.token_address), name: nullableString(row.name), symbol: nullableString(row.symbol),
    platform: string(row.platform), protocolVersion: string(row.protocol_version),
    quoteAsset: { address: string(row.quote_asset_address), symbol: nullableString(row.quote_asset_symbol), decimals: nullableNumber(row.quote_asset_decimals) },
    lifecycleStatus: string(row.lifecycle_status),
    officialVolume24h: complete && row.official_volume_raw !== undefined && row.quote_asset_decimals !== null
      ? formatUnits(BigInt(string(row.official_volume_raw)), number(row.quote_asset_decimals)) : null,
    coverageStatus,
    logoUri: row.logo_uri === null || row.logo_uri === undefined ? null : string(row.logo_uri),
    websiteUrl: row.website_url === null || row.website_url === undefined ? null : string(row.website_url),
    twitterUrl: row.twitter_url === null || row.twitter_url === undefined ? null : string(row.twitter_url),
    launchTimestamp: row.launch_timestamp === null || row.launch_timestamp === undefined ? null : string(row.launch_timestamp),
    // Only sort=volume24hUsd computes these (listLaunchesByVolume overrides them on its own
    // returned items) — every other path (recency list, getLaunch) stays honestly null rather
    // than paying for a global-ranking-shaped computation it doesn't need.
    officialVolume24hUsd: null, officialVolume24hUsdApprox: false,
    ...stats,
  };
}

interface StatsFields extends TvlFields { fdvUsd: string | null; marketCapUsd: string | null; week52High: string | null; week52Low: string | null; change1h: string | null; change1d: string | null }
const NULL_STATS: StatsFields = { fdvUsd: null, marketCapUsd: null, week52High: null, week52Low: null, change1h: null, change1d: null, ...NULL_TVL };

async function computeTvl(pool: Pool, rpcClient: UsdPriceClient, row: Row): Promise<TvlFields> {
  if (row.token_decimals === null || row.quote_asset_decimals === null) {
    // A near-realtime-synced launch awaiting core-metadata enrichment — no fabricated decimals.
    return { ...NULL_TVL, tvlUnavailableReason: 'decimals_unknown' };
  }
  try {
    const venueResult = await pool.query(`SELECT kind, ref FROM venues WHERE chain_id = $1 AND token_address = $2
      AND official = true AND effective_to_block IS NULL
      ORDER BY effective_from_block DESC, effective_from_log_index DESC LIMIT 1`,
    [number(row.chain_id), string(row.token_address)]);
    const current = venueResult.rows[0] as Row | undefined;
    const kind = current?.kind;
    const venue = current && (kind === 'curve' || kind === 'v3_pool' || kind === 'v4_pool')
      ? { kind: kind as VenueAmountInput['kind'], ref: string(current.ref) } : null;
    return await readCurrentTvl(pool, rpcClient, { chainId: number(row.chain_id), token: string(row.token_address),
      quote: string(row.quote_asset_address), tokenDecimals: number(row.token_decimals),
      quoteDecimals: number(row.quote_asset_decimals), protocolVersion: string(row.protocol_version),
      factory: string(row.factory_address), lifecycleStatus: string(row.lifecycle_status), venue,
      v4PoolFee: row.v4_pool_fee === null ? null : number(row.v4_pool_fee),
      v4TickSpacing: row.v4_tick_spacing === null ? null : number(row.v4_tick_spacing) });
  } catch { return { ...NULL_TVL, tvlUnavailableReason: 'onchain_read_failed' }; }
}

// TVL reads current chain state independently of historical trade coverage. FDV and 52W extrema
// retain their existing coverage gate. An RPC error in either path cannot erase the other.
async function computeStats(pool: Pool, rpcClient: UsdPriceClient | undefined, row: Row,
  complete: boolean): Promise<StatsFields> {
  const tvl = rpcClient ? await computeTvl(pool, rpcClient, row) : NULL_TVL;
  // The latest indexed trade and the 52-week range cannot be presented as current/complete
  // while an official source is behind the safe head. Match priceQuote's coverage rule.
  if (!rpcClient || !complete) return { ...NULL_STATS, ...tvl };
  try {
    const [usdPrice, totalSupply, priceResult] = await Promise.all([
      readUsdPrice(pool, rpcClient, string(row.quote_asset_address)),
      readTotalSupply(rpcClient, string(row.token_address) as Address),
      pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
          AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`, [number(row.chain_id), string(row.token_address)]),
    ]);
    const priceRow = priceResult.rows[0] as Row | undefined;
    const priceInQuoteAsset = priceRow
      ? formatRational(BigInt(string(priceRow.price_numerator_raw)), BigInt(string(priceRow.price_denominator_raw)), 18) : null;
    const fdvUsd = totalSupply !== null && row.token_decimals !== null
      ? computeFdvUsd(totalSupply, number(row.token_decimals), priceInQuoteAsset, usdPrice?.priceUsd ?? null) : null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const cacheReady = (await pool.query('SELECT backfill_complete FROM candle_cache_state WHERE id = 1')).rows[0]?.backfill_complete === true;
    let high: string | null;
    let low: string | null;
    let pricedTrades: { timestamp: number; price: string }[];
    if (cacheReady) {
      const extrema = await read52WeekHighLowFromCandles(pool, number(row.chain_id), string(row.token_address), nowSeconds);
      high = extrema.complete ? extrema.high : null;
      low = extrema.complete ? extrema.low : null;
      // Price changes need only the past day plus the last priced trade before its boundary.
      // This keeps a 52-week trade scan out of the cached path.
      const since1d = nowSeconds - 86_400;
      const [baseline, recent] = await Promise.all([
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp < $3 AND t.timestamp >= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds - 52 * 7 * 86_400]),
        pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
          FROM trades t JOIN venues v ON v.id = t.venue_id
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
            AND t.timestamp >= $3 AND t.timestamp <= $4
            AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
          ORDER BY t.block_number, t.log_index`,
        [number(row.chain_id), string(row.token_address), since1d, nowSeconds]),
      ]);
      pricedTrades = [...baseline.rows, ...recent.rows].map((r: Row) => ({
        timestamp: number(r.timestamp),
        price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
      }));
    } else {
      // Until the historical candle backfill finishes, preserve the existing trade-based result.
      const since = nowSeconds - 52 * 7 * 86_400;
      const highLowResult = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, t.timestamp
        FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true AND t.timestamp >= $3
          AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number, t.log_index`, [number(row.chain_id), string(row.token_address), since]);
      // Format once and reuse for both high/low and 1h/1d change — this branch used to format
      // every row twice (once into `prices`, once into `pricedTrades`).
      pricedTrades = (highLowResult.rows as Row[]).map((r) => ({
        timestamp: number(r.timestamp),
        price: formatRational(BigInt(string(r.price_numerator_raw)), BigInt(string(r.price_denominator_raw)), 18),
      }));
      ({ high, low } = compute52WeekHighLow(pricedTrades.map((t) => ({ high: t.price, low: t.price }))));
    }
    const change1h = computePriceChange(pricedTrades, nowSeconds, 3600);
    const change1d = computePriceChange(pricedTrades, nowSeconds, 86400);

    return { fdvUsd, marketCapUsd: fdvUsd, week52High: high, week52Low: low, change1h, change1d, ...tvl };
  } catch {
    return { ...NULL_STATS, ...tvl };
  }
}

function page<T>(rows: readonly Row[], limit: number, map: (row: Row, index: number) => T): Page<T> {
  const included = rows.slice(0, limit);
  const last = included.at(-1);
  return { items: included.map(map), nextCursor: rows.length > limit && last ? encodeCursor({
    blockNumber: BigInt(string(last.block_number)), txHash: string(last.tx_hash), logIndex: number(last.log_index),
  }) : null };
}

export function createApiStore(pool: Pool, rpcClient?: UsdPriceClient): ApiDeps['data'] {
  // GREATEST(a, b) ignores a NULL operand (returning the other) unless both are NULL — exactly the
  // "use whichever source has a reading, prefer the more current one" behavior needed here.
  // observed_blocks is only ever written by the RPC-scan indexer; envio_chain_progress mirrors
  // Envio's own chain head (be/src/envioSync/syncAll.ts's runAllSyncsOnce, 'real' target only) — once
  // the RPC-scan indexer stops at cutover, observed_blocks freezes, and without this, every source's
  // coverage would be judged against that stale value forever (final review, Important 3).
  const safeHeadSql = `SELECT GREATEST(
    (SELECT max(number) FROM observed_blocks WHERE chain_id = 4663),
    (SELECT head_block FROM envio_chain_progress WHERE chain_id = 4663)
  ) AS safe_head`;
  async function safeHead(): Promise<bigint | null> {
    const result = await pool.query(safeHeadSql);
    return result.rows[0]?.safe_head === null ? null : BigInt(string(result.rows[0].safe_head));
  }
  async function coverage() {
    const [sourceResult, headResult, gapResult, poolResult, phaseResult] = await Promise.all([
      pool.query('SELECT id, status, confirmed_to_block, start_block FROM sources'),
      pool.query(safeHeadSql),
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
    const finalizedTarget = head === null || head < 500n ? null : head - 500n;
    const launchParity = await Promise.all(getPonsFactorySources().filter((source) => source.enabled)
      .map((source) => readLaunchParityCoverage(pool, source, finalizedTarget)));
    for (const item of launchParity) {
      if (item.status !== 'complete' && !pendingSourceIds.includes(item.sourceId)) pendingSourceIds.push(item.sourceId);
    }
    const pendingRepairs = await pool.query("SELECT count(*)::int AS count FROM launch_parity_repairs WHERE status = 'pending'");
    const parityAlerts = { mismatchedSources: launchParity.filter((item) => item.status === 'mismatch').length,
      stalledSources: launchParity.filter((item) => item.envioWatermark !== null && finalizedTarget !== null
        && BigInt(item.envioWatermark) < finalizedTarget).length,
      pendingRepairs: number(pendingRepairs.rows[0]?.count) };
    return { complete: pendingSourceIds.length === 0 && missingRanges.length === 0, pendingSourceIds, missingRanges,
      latestFinalizedFence: finalizedTarget?.toString() ?? null, launchParity, parityAlerts,
      incrementalSync: await incrementalSyncCoverage() };
  }

  // Observability for the near-realtime incremental sync path — separate from the sources-table
  // coverage above, which only the old full-table sync (still available offline) ever writes.
  async function incrementalSyncCoverage(): Promise<IncrementalSyncCoverage> {
    const [headResult, tailConfirmed, historyConfirmed, unresolvedResult, coreMetadataResult, repairState] = await Promise.all([
      pool.query('SELECT head_block FROM envio_chain_progress WHERE chain_id = 4663'),
      readConfirmedSourceBlock(pool, 4663, STREAM_ORDER, 'tail'),
      readConfirmedSourceBlock(pool, 4663, STREAM_ORDER, 'history'),
      pool.query('SELECT count(*)::int AS count FROM unresolved_events WHERE chain_id = 4663'),
      pool.query("SELECT count(*)::int AS count FROM launches WHERE chain_id = 4663 AND core_metadata_read_state = 'pending'"),
      readRepairState(pool, 4663),
    ]);
    const observedHead = headResult.rows[0]?.head_block === undefined || headResult.rows[0]?.head_block === null
      ? null : BigInt(string(headResult.rows[0].head_block));
    return {
      observedEnvioHead: observedHead?.toString() ?? null,
      tailConfirmedBlock: tailConfirmed?.toString() ?? null,
      historyConfirmedBlock: historyConfirmed?.toString() ?? null,
      tailLagBlocks: observedHead !== null && tailConfirmed !== null ? (observedHead - tailConfirmed).toString() : null,
      historyBacklogBlocks: observedHead !== null && historyConfirmed !== null ? (observedHead - historyConfirmed).toString() : null,
      unresolvedEventCount: number(unresolvedResult.rows[0]?.count),
      pendingCoreMetadataCount: number(coreMetadataResult.rows[0]?.count),
      repair: {
        lastRunAt: repairState.lastRunAt?.toISOString() ?? null, lastSuccessAt: repairState.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: repairState.lastFailureAt?.toISOString() ?? null, lastFailureReason: repairState.lastFailureReason,
        failureCount: repairState.failureCount,
      },
    };
  }

  async function listLaunchesByVolume(query: LaunchListQuery): Promise<Page<LaunchSummary>> {
    const secret = process.env.VOLUME_CURSOR_SECRET;
    if (!secret) throw new Error('VOLUME_CURSOR_SECRET is required to use sort=volume24hUsd');
    const head = await safeHead();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cursorValue = query.cursor ? decodeVolumeCursor(query.cursor, secret, nowSeconds) : null;
    const asOf = cursorValue?.asOf ?? nowSeconds;
    const since = asOf - 86_400;

    // Base set: every launch matching the filters, with its coverage-complete flag (reuses the
    // existing per-launch coverage rule used by the recency path — same semantics, just no
    // pagination predicate here, since the final order depends on volume, not launch position) and
    // the same raw quote-unit official_volume_raw subquery the recency path uses, so this sort
    // doesn't silently drop that field (final review, Important 1).
    const baseResult = await pool.query(`
      SELECT l.chain_id, l.token_address, l.name, l.symbol, l.platform, l.protocol_version, l.token_decimals,
        l.factory_address, l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals, l.lifecycle_status,
        l.v4_pool_fee, l.v4_tick_spacing, l.logo_uri, l.website_url, l.twitter_url, l.launch_timestamp,
        l.launch_block AS block_number, l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
        ${launchCoverageSql(5)} AS launch_coverage_complete,
        (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
         WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
           AND t.timestamp >= $6) AS official_volume_raw
      FROM launches l JOIN sources s ON s.id = l.source_id
      WHERE ($1::integer IS NULL OR l.chain_id = $1) AND ($2::text IS NULL OR l.platform = $2)
        AND ($3::text IS NULL OR l.lifecycle_status = $3)
        AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.symbol ILIKE '%' || $4 || '%')
    `, [query.chainId ?? null, query.platform ?? null, query.status ?? null, query.search ?? null, head?.toString() ?? null, since]);
    const launchRows = baseResult.rows as Row[];

    // Per-trade historical USD valuation for every official trade of every matching launch in the
    // window — one LATERAL join against quote_usd_price_rounds, deliberately mirroring
    // tradeValuation.ts's valueTradeUsd selection logic exactly (round at or before the trade's own
    // (blockNumber, logIndex), rejected if stale) so the two never disagree. If this ever needs to
    // change, change valueTradeUsd's math and this query in the same commit.
    const tradesResult = await pool.query(`
      SELECT l.chain_id, l.token_address, l.quote_asset_decimals, t.quote_amount_raw, t.block_number, t.log_index, t.timestamp,
        f.feed_address, r.answer_raw, r.decimals AS price_decimals, r.updated_at AS price_updated_at
      FROM launches l
      JOIN venues v ON v.chain_id = l.chain_id AND v.token_address = l.token_address AND v.official = true
      JOIN trades t ON t.chain_id = v.chain_id AND t.token_address = v.token_address AND t.venue_id = v.id
        AND t.timestamp >= $1 AND t.timestamp <= $2
      LEFT JOIN quote_usd_feeds f ON f.chain_id = l.chain_id AND f.quote_asset_address = l.quote_asset_address AND f.verification_status = 'verified'
      LEFT JOIN LATERAL (
        SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
        WHERE chain_id = f.chain_id AND feed_address = f.feed_address AND (block_number, log_index) <= (t.block_number, t.log_index)
        ORDER BY block_number DESC, log_index DESC LIMIT 1
      ) r ON true
      WHERE ($3::integer IS NULL OR l.chain_id = $3) AND ($4::text IS NULL OR l.platform = $4)
        AND ($5::text IS NULL OR l.lifecycle_status = $5) AND ($6::text IS NULL OR l.name ILIKE '%' || $6 || '%' OR l.symbol ILIKE '%' || $6 || '%')
    `, [since, asOf, query.chainId ?? null, query.platform ?? null, query.status ?? null, query.search ?? null]);

    // Fixed-point bigint accumulation, never floating point: float addition is not associative, so
    // the exact same set of trades could sum to a different string depending on row order (a real
    // Postgres LATERAL join gives no row-order guarantee) — breaking both the cursor's exact-match
    // reseek and giving the same launch a different volume on every request (final review,
    // Important 2 / Minor). USD_SCALE is far beyond any realistic quoteDecimals+priceDecimals
    // combination, so each row's own scaled contribution is computed exactly before summing.
    const USD_SCALE = 10n ** 30n;
    interface VolumeAgg { usdTotalScaled: bigint; hasUnpriced: boolean; hasTrades: boolean }
    const byLaunch = new Map<string, VolumeAgg>();
    for (const row of tradesResult.rows as Row[]) {
      const key = `${number(row.chain_id)}:${string(row.token_address)}`;
      const agg = byLaunch.get(key) ?? { usdTotalScaled: 0n, hasUnpriced: false, hasTrades: false };
      agg.hasTrades = true;
      if (row.feed_address === null || row.answer_raw === null || row.quote_asset_decimals === null) {
        agg.hasUnpriced = true;
      } else {
        const ageSeconds = number(row.timestamp) - number(row.price_updated_at);
        if (ageSeconds < 0 || ageSeconds > 86_400) {
          agg.hasUnpriced = true;
        } else {
          const quoteAmountRaw = BigInt(string(row.quote_amount_raw));
          const answerRaw = BigInt(string(row.answer_raw));
          const divisor = 10n ** BigInt(number(row.quote_asset_decimals)) * 10n ** BigInt(number(row.price_decimals));
          agg.usdTotalScaled += (quoteAmountRaw * answerRaw * USD_SCALE) / divisor;
        }
      }
      byLaunch.set(key, agg);
    }

    interface RankedLaunch { row: Row; complete: boolean; usd: string | null; approx: boolean }
    function rankCategory(usd: string | null): 'positive' | 'zero' | 'null' {
      return usd === null ? 'null' : Number(usd) > 0 ? 'positive' : 'zero';
    }
    const categoryOrder = { positive: 0, zero: 1, null: 2 } as const;

    const ranked: RankedLaunch[] = launchRows.map((row) => {
      const complete = Boolean(row.launch_coverage_complete);
      const agg = byLaunch.get(`${number(row.chain_id)}:${string(row.token_address)}`);
      if (!complete) return { row, complete, usd: null, approx: false };
      if (!agg || !agg.hasTrades) return { row, complete, usd: '0', approx: false };
      if (agg.hasUnpriced) return { row, complete, usd: null, approx: false };
      return { row, complete, usd: formatUnits(agg.usdTotalScaled, 30), approx: true };
    });

    ranked.sort((a, b) => {
      const catA = rankCategory(a.usd);
      const catB = rankCategory(b.usd);
      if (categoryOrder[catA] !== categoryOrder[catB]) return categoryOrder[catA] - categoryOrder[catB];
      if (catA === 'positive') {
        const diff = Number(b.usd) - Number(a.usd);
        if (diff !== 0) return diff;
      }
      const blockA = BigInt(string(a.row.block_number));
      const blockB = BigInt(string(b.row.block_number));
      if (blockA !== blockB) return blockA > blockB ? -1 : 1;
      const txCompare = string(b.row.tx_hash).localeCompare(string(a.row.tx_hash));
      if (txCompare !== 0) return txCompare;
      return number(b.row.log_index) - number(a.row.log_index);
    });

    let startIndex = 0;
    if (cursorValue) {
      const pinnedIndex = ranked.findIndex((item) =>
        rankCategory(item.usd) === cursorValue.rankCategory && (item.usd ?? null) === cursorValue.rankValue
        && string(item.row.block_number) === cursorValue.tiebreakBlockNumber && string(item.row.tx_hash) === cursorValue.tiebreakTxHash
        && number(item.row.log_index) === cursorValue.tiebreakLogIndex);
      if (pinnedIndex === -1) throw new InvalidVolumeCursorError('Invalid cursor');
      startIndex = pinnedIndex + 1;
    }
    const slice = ranked.slice(startIndex, startIndex + query.limit + 1);
    const included = slice.slice(0, query.limit);
    const last = included.at(-1);
    const nextCursor = slice.length > query.limit && last
      ? encodeVolumeCursor({ version: 1, sort: 'volume24hUsd', asOf, rankCategory: rankCategory(last.usd), rankValue: last.usd,
        tiebreakBlockNumber: string(last.row.block_number), tiebreakTxHash: string(last.row.tx_hash), tiebreakLogIndex: number(last.row.log_index) }, secret)
      : null;

    const statsByToken = new Map(await Promise.all(included.map(async (item) =>
      [string(item.row.token_address), await computeStats(pool, rpcClient, item.row, item.complete)] as const)));
    return {
      items: included.map((item) => ({
        ...summary(item.row, item.complete, statsByToken.get(string(item.row.token_address)) ?? NULL_STATS),
        officialVolume24hUsd: item.usd, officialVolume24hUsdApprox: item.approx,
      })),
      nextCursor,
    };
  }

  return {
    async listSources() {
      const result = await pool.query('SELECT id, chain_id, version FROM sources ORDER BY id');
      return result.rows.filter((row: Row) => baseSourceIds.includes(string(row.id)) || string(row.id).startsWith('pons-v2-v4:'))
        .map((row: Row) => ({ id: string(row.id), chainId: number(row.chain_id), platform: 'pons', protocolVersion: string(row.version) }));
    },
    getCoverage: coverage,
    async listLaunches(query: LaunchListQuery) {
      if (query.sort === 'volume24hUsd') return listLaunchesByVolume(query);
      const head = await safeHead();
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const result = await pool.query(`
        SELECT l.chain_id, l.token_address, l.name, l.symbol, l.platform, l.protocol_version, l.token_decimals,
          l.factory_address, l.quote_asset_address, l.quote_asset_symbol, l.quote_asset_decimals, l.lifecycle_status,
          l.v4_pool_fee, l.v4_tick_spacing, l.logo_uri, l.website_url, l.twitter_url, l.launch_timestamp,
          s.status AS source_status, l.launch_block AS block_number,
          l.launch_tx_hash AS tx_hash, l.launch_log_index AS log_index,
          (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
           WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
             AND t.timestamp >= $6) AS official_volume_raw,
          ${launchCoverageSql(9)} AS launch_coverage_complete
        FROM launches l JOIN sources s ON s.id = l.source_id
        WHERE ($1::integer IS NULL OR l.chain_id = $1)
          AND ($2::bigint IS NULL OR (l.launch_block, l.launch_tx_hash, l.launch_log_index) < ($2::bigint, $3::text, $4::integer))
          AND ($7::text IS NULL OR l.name ILIKE '%' || $7 || '%' OR l.symbol ILIKE '%' || $7 || '%')
          AND ($8::text IS NULL OR l.lifecycle_status = $8)
          AND ($10::text IS NULL OR l.platform = $10)
        ORDER BY l.launch_block DESC, l.launch_tx_hash DESC, l.launch_log_index DESC LIMIT $5`,
      [query.chainId ?? null, cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null, cursor?.logIndex ?? null, query.limit + 1, since,
        query.search ?? null, query.status ?? null, head?.toString() ?? null, query.platform ?? null]);
      const rows = result.rows as Row[];
      const statsByToken = new Map(await Promise.all(rows.slice(0, query.limit).map(async (row) =>
        [string(row.token_address), await computeStats(pool, rpcClient, row,
          Boolean(row.launch_coverage_complete))] as const)));
      return page(rows, query.limit, (row) => summary(row, Boolean(row.launch_coverage_complete),
        statsByToken.get(string(row.token_address)) ?? NULL_STATS));
    },
    async getLaunch(chainId: number, tokenAddress: string): Promise<LaunchDetail | null> {
      const head = await safeHead();
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const result = await pool.query(`SELECT l.*, s.status AS source_status,
        (SELECT COALESCE(sum(t.quote_amount_raw), 0)::text FROM trades t JOIN venues v ON v.id = t.venue_id
         WHERE t.chain_id = l.chain_id AND t.token_address = l.token_address AND v.official = true
           AND t.timestamp >= $3) AS official_volume_raw,
        ${launchCoverageSql(4)} AS launch_coverage_complete
        FROM launches l JOIN sources s ON s.id = l.source_id
        WHERE l.chain_id = $1 AND l.token_address = $2 LIMIT 1`,
      [chainId, tokenAddress.toLowerCase(), since, head?.toString() ?? null]);
      const row = result.rows[0] as Row | undefined;
      if (!row) return null;
      const complete = Boolean(row.launch_coverage_complete);
      const venueRows = await pool.query(`SELECT id, kind, ref, effective_from_block, effective_to_block FROM venues
        WHERE chain_id = $1 AND token_address = $2 AND official = true ORDER BY effective_from_block`, [chainId, tokenAddress.toLowerCase()]);
      const lastPrice = await pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw, v.kind AS venue_kind FROM trades t
        JOIN venues v ON v.id = t.venue_id WHERE t.chain_id = $1 AND t.token_address = $2
        AND v.official = true AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`, [chainId, tokenAddress.toLowerCase()]);
      const priced = lastPrice.rows[0] as Row | undefined;
      const stats = await computeStats(pool, rpcClient, row, complete);
      return { ...summary(row, complete, stats),
        description: row.description === null || row.description === undefined ? null : string(row.description),
        officialVenues: venueRows.rows.map((venue: Row) => ({
        id: string(venue.id), kind: string(venue.kind), ref: string(venue.ref),
        effectiveFromBlock: string(venue.effective_from_block),
        effectiveToBlock: venue.effective_to_block === null ? null : string(venue.effective_to_block),
      })), priceQuote: complete && priced
        ? formatRational(BigInt(string(priced.price_numerator_raw)), BigInt(string(priced.price_denominator_raw)), 18) : null,
      priceStale: row.protocol_version === 'v2' && row.lifecycle_status !== 'trading'
        && (row.lifecycle_status !== 'graduated' || priced?.venue_kind !== 'v4_pool') };
    },
    async listTrades(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TradeResponse>> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const result = await pool.query(`SELECT t.*, l.token_decimals, l.quote_asset_decimals, l.quote_asset_address AS launch_quote_asset_address
        FROM trades t JOIN venues v ON v.id = t.venue_id
        JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
          AND ($3::bigint IS NULL OR (t.block_number, t.tx_hash, t.log_index) < ($3::bigint, $4::text, $5::integer))
        ORDER BY t.block_number DESC, t.tx_hash DESC, t.log_index DESC LIMIT $6`,
      [chainId, tokenAddress.toLowerCase(), cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null,
        cursor?.logIndex ?? null, query.limit + 1]);
      const rows = result.rows as Row[];
      // Every row on one launch's trade page shares the same quote asset, so this calls
      // resolveVerifiedFeed (inside valueTradeUsd) once per row redundantly — bounded by
      // query.limit (≤100), acceptable for now; if Task 11's benchmark shows this dominating,
      // resolve the feed once above this loop and thread it into a valueTradeUsd overload.
      const valuations = await Promise.all(rows.map((row) => valueTradeUsd(pool, chainId, string(row.launch_quote_asset_address), {
        timestamp: number(row.timestamp), quoteAmountRaw: BigInt(string(row.quote_amount_raw)),
        quoteAssetDecimals: nullableNumber(row.quote_asset_decimals), blockNumber: BigInt(string(row.block_number)), logIndex: number(row.log_index),
      })));
      // Demand-driven backfill: a `pending` row means a verified feed exists but this trade's exact
      // round isn't backfilled yet. Coalesce every pending row on this page into ONE bounded,
      // deduplicated job covering [earliest-3600, latest+3600] — one job per feed per page, never
      // one per row (final review, Important 5: up to 100 rows/page would otherwise mean up to 100
      // jobs, each re-running its own pair of binary-searched block lookups for the same feed).
      // Fire-and-forget after the response data is already computed; never block the page on it.
      const feed = rows[0] ? await resolveVerifiedFeed(pool, chainId, string(rows[0].launch_quote_asset_address)) : null;
      if (feed) {
        const pendingTimestamps = valuations
          .map((valuation, i) => (valuation.status === 'pending' ? number(rows[i]!.timestamp) : null))
          .filter((t): t is number => t !== null);
        if (pendingTimestamps.length > 0) {
          const rangeStart = Math.min(...pendingTimestamps) - 3600;
          const rangeEnd = Math.max(...pendingTimestamps) + 3600;
          // Coalesced to one insert per page (not per row), so awaiting it adds negligible latency
          // — and avoids a real race where a fire-and-forget insert on one pooled connection isn't
          // yet visible to a client that immediately re-queries price_jobs on a different one.
          await enqueueRoundBackfillJob(pool, chainId, feed.feedAddress, rangeStart, rangeEnd).catch(() => {});
        }
      }
      return page(rows, query.limit, (row, i) => ({
        venueId: string(row.venue_id), blockNumber: string(row.block_number), txHash: string(row.tx_hash),
        logIndex: number(row.log_index), timestamp: number(row.timestamp), side: string(row.side),
        activityKind: string(row.activity_kind),
        tokenAmount: row.token_decimals === null ? null : formatUnits(BigInt(string(row.token_amount_raw)), number(row.token_decimals)),
        quoteAmount: row.quote_asset_decimals === null ? null : formatUnits(BigInt(string(row.quote_amount_raw)), number(row.quote_asset_decimals)),
        priceQuote: row.price_numerator_raw === null || row.price_denominator_raw === null ? null
          : formatRational(BigInt(string(row.price_numerator_raw)), BigInt(string(row.price_denominator_raw)), 18),
        traderAddress: string(row.trader_address),
        usdValue: valuations[i]!.status === 'priced' ? (valuations[i] as { status: 'priced'; usdValue: string }).usdValue : null,
        usdValueApprox: valuations[i]!.status === 'priced',
        usdValueStatus: valuations[i]!.status,
      })) as Page<TradeResponse>;
    },
    async listCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number): Promise<{ items: readonly CandleResponse[]; complete: boolean }> {
      const head = await safeHead();
      const launchResult = await pool.query(`SELECT quote_asset_address, quote_asset_decimals,
        ${launchCoverageSql(3)} AS launch_coverage_complete
        FROM launches l WHERE l.chain_id = $1 AND l.token_address = $2 LIMIT 1`,
      [chainId, tokenAddress.toLowerCase(), head?.toString() ?? null]);
      const launch = launchResult.rows[0] as Row | undefined;
      if (!launch) return { items: [], complete: false };
      const end = before ?? Math.floor(Date.now() / 1000) + 1;
      const start = Math.floor((end - 1) / intervalSeconds) * intervalSeconds - 499 * intervalSeconds;
      const cacheState = await pool.query('SELECT backfill_complete FROM candle_cache_state WHERE id = 1');
      if (cacheState.rows[0]?.backfill_complete === true) {
        const [cached, pending] = await Promise.all([
          pool.query(`SELECT c.bucket_start, c.open, c.high, c.low, c.close, c.quote_volume_raw
            FROM candles c WHERE c.chain_id = $1 AND c.token_address = $2 AND c.interval_seconds = $3
              AND c.bucket_start >= $4 AND c.bucket_start < $5
              AND NOT EXISTS (SELECT 1 FROM candle_dirty_buckets d
                WHERE d.chain_id = c.chain_id AND d.token_address = c.token_address
                  AND d.bucket_start >= c.bucket_start AND d.bucket_start < c.bucket_start + $3)
            ORDER BY c.bucket_start DESC LIMIT 500`, [chainId, tokenAddress.toLowerCase(), intervalSeconds, start, end]),
          pool.query(`SELECT
              EXISTS (SELECT 1 FROM candle_dirty_buckets d WHERE d.chain_id = $1 AND d.token_address = $2
                AND d.bucket_start >= $3 AND d.bucket_start < $4) AS dirty,
              EXISTS (SELECT 1 FROM candle_unpriced_buckets u
                WHERE u.chain_id = $1 AND u.token_address = $2
                  AND u.bucket_start >= $3 AND u.bucket_start < $4) AS unpriced`,
          [chainId, tokenAddress.toLowerCase(), start, end]),
        ]);
        const state = pending.rows[0] as Row;
        return { complete: Boolean(launch.launch_coverage_complete) && !state.dirty && !state.unpriced,
          items: (cached.rows as Row[]).map((row) => ({ intervalSeconds, bucketStart: number(row.bucket_start),
            open: string(row.open), high: string(row.high), low: string(row.low), close: string(row.close),
            quoteVolume: formatUnits(BigInt(string(row.quote_volume_raw)), number(launch.quote_asset_decimals)),
          })) };
      }
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
        traderAddress: string(row.trader_address) as Address,
      }));
      const candles = buildOfficialCandles(mapped, intervalSeconds, { chainId, tokenAddress: tokenAddress.toLowerCase() as Address,
        quoteAssetAddress: string(launch.quote_asset_address) as Address,
        venueIds: new Set(rows.map((row) => string(row.venue_id))), complete: true });
      return { complete: Boolean(launch.launch_coverage_complete)
        && !rows.some((row) => row.price_numerator_raw === null || row.price_denominator_raw === null),
        items: candles.reverse().map((candle) => ({ intervalSeconds, bucketStart: candle.bucketStart,
        open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        quoteVolume: formatUnits(candle.quoteVolumeRaw, number(launch.quote_asset_decimals)),
      })) };
    },
  };
}
