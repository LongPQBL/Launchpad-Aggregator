import type { Pool } from 'pg';
import { formatUnits, type Address, type Hash } from 'viem';
import type { Trade } from '../domain/types.js';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { readLaunchParityCoverage } from '../coverage/repairRanges.js';
import { launchCoverageSql, SAFE_HEAD_SQL } from '../coverage/launchCoverageSql.js';
import { formatRational } from '../market/price.js';
import { buildOfficialCandles, compute52WeekHighLow, computePriceChange } from '../market/aggregate.js';
import { read52WeekHighLowFromCandles } from '../market/candleStats.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { enqueueRoundBackfillJob } from '../market/quotePricing/priceJobStore.js';
import { assetDecimals } from '../pools/stats.js';
import { decodeVolumeCursor, encodeVolumeCursor } from './volumeCursor.js';
import { readVolumeRankingPage } from '../market/launchVolume/ranking.js';
import { assertVolumeRankingAvailable } from '../market/launchVolume/state.js';
import { computeFdvUsd, readTotalSupply } from '../market/tokenStats.js';
import { ttlMemo } from './ttlMemo.js';
import { readLaunchStats } from './launchStatsStore.js';
import { readCurrentTvl, NULL_TVL, type TvlFields } from '../market/tvlStats.js';
import type { VenueAmountInput } from '../market/tvlReserves.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { readMetricRankingPage } from './metricRanking.js';
import { readConfirmedSourceBlock, STREAM_ORDER } from '../envioSync/incrementalSync.js';
import { readRepairState } from '../envioSync/incrementalRepair.js';
import type { ApiDeps, CandleResponse, UsdCandleResponse, IncrementalSyncCoverage, LaunchDetail, LaunchListQuery, LaunchSummary, ListQuery, Page, TradeResponse, TransactionResponse } from './server.js';

type Row = Record<string, unknown>;
const baseSourceIds = [...getPonsFactorySources().map((source) => source.id),
  'pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve', 'pons-v2-lifecycle'];

function string(value: unknown): string { return String(value); }
function number(value: unknown): number { return Number(value); }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }

function summary(row: Row, complete: boolean, stats: StatsFields): LaunchSummary {
  const coverageStatus = complete ? 'caught_up' : 'backfilling';
  return {
    chainId: number(row.chain_id), tokenAddress: string(row.token_address), name: nullableString(row.name), symbol: nullableString(row.symbol),
    platform: string(row.platform), protocolVersion: string(row.protocol_version),
    quoteAsset: { address: string(row.quote_asset_address), symbol: nullableString(row.quote_asset_symbol), decimals: nullableNumber(row.quote_asset_decimals) },
    lifecycleStatus: string(row.lifecycle_status),
    tokenDecimals: nullableNumber(row.token_decimals),
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
    officialVolume24hUsd: null, officialVolume24hUsdApprox: false, officialVolume24hUsdAsOf: null,
    ...stats,
  };
}

export interface StatsFields extends TvlFields { fdvUsd: string | null; marketCapUsd: string | null; priceUsd: string | null; week52High: string | null; week52Low: string | null; change1h: string | null; change1d: string | null }
const NULL_STATS: StatsFields = { fdvUsd: null, marketCapUsd: null, priceUsd: null, week52High: null, week52Low: null, change1h: null, change1d: null, ...NULL_TVL };

// The launch page recomputes these per request; the RPC answers change on the scale of minutes, and
// the page is re-fetched on every visit, so a short per-(pool, client) cache keeps repeat loads fast.
const CHAIN_READ_TTL_MS = 60_000;
const usdPriceMemos = new WeakMap<Pool, WeakMap<UsdPriceClient, ReturnType<typeof ttlMemo<string, Awaited<ReturnType<typeof readUsdPrice>>>>>>();
const totalSupplyMemos = new WeakMap<UsdPriceClient, ReturnType<typeof ttlMemo<string, bigint | null>>>();
function cachedUsdPrice(pool: Pool, client: UsdPriceClient, quoteAssetAddress: string) {
  let byClient = usdPriceMemos.get(pool);
  if (!byClient) { byClient = new WeakMap(); usdPriceMemos.set(pool, byClient); }
  let memo = byClient.get(client);
  if (!memo) { memo = ttlMemo((quote: string) => readUsdPrice(pool, client, quote), CHAIN_READ_TTL_MS); byClient.set(client, memo); }
  return memo(quoteAssetAddress);
}
const tvlMemos = new WeakMap<Pool, WeakMap<UsdPriceClient, ReturnType<typeof ttlMemo<string, TvlFields, Row>>>>();
function cachedTvl(pool: Pool, client: UsdPriceClient, row: Row): Promise<TvlFields> {
  let byClient = tvlMemos.get(pool);
  if (!byClient) { byClient = new WeakMap(); tvlMemos.set(pool, byClient); }
  let memo = byClient.get(client);
  if (!memo) { memo = ttlMemo((_key: string, launchRow: Row) => computeTvl(pool, client, launchRow), CHAIN_READ_TTL_MS); byClient.set(client, memo); }
  return memo(`${number(row.chain_id)}:${string(row.token_address)}`, row);
}
function cachedTotalSupply(client: UsdPriceClient, tokenAddress: string) {
  let memo = totalSupplyMemos.get(client);
  if (!memo) { memo = ttlMemo((token: string) => readTotalSupply(client, token as Address), CHAIN_READ_TTL_MS); totalSupplyMemos.set(client, memo); }
  return memo(tokenAddress);
}

// Stored figures were computed while coverage was complete; coverage can lapse later, so the read
// applies the same rule as computeStats: FDV, extrema, and changes are withheld, TVL is kept.
function statsForCoverage(stored: StatsFields | undefined, complete: boolean): StatsFields {
  if (!stored) return NULL_STATS;
  if (complete) return stored;
  const tvl = Object.fromEntries(Object.keys(NULL_TVL).map((key) => [key, (stored as unknown as Record<string, unknown>)[key]]));
  return { ...NULL_STATS, ...tvl } as StatsFields;
}

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
export async function computeStats(pool: Pool, rpcClient: UsdPriceClient | undefined, row: Row,
  complete: boolean): Promise<StatsFields> {
  // Started now so the TVL reads run alongside the price and supply reads below, not after them.
  const tvlPromise = rpcClient ? cachedTvl(pool, rpcClient, row) : Promise.resolve(NULL_TVL);
  // The latest indexed trade and the 52-week range cannot be presented as current/complete
  // while an official source is behind the safe head. Match priceQuote's coverage rule.
  if (!rpcClient || !complete) return { ...NULL_STATS, ...(await tvlPromise) };
  try {
    const [usdPrice, totalSupply, priceResult] = await Promise.all([
      cachedUsdPrice(pool, rpcClient, string(row.quote_asset_address)),
      cachedTotalSupply(rpcClient, string(row.token_address)),
      pool.query(`SELECT t.price_numerator_raw, t.price_denominator_raw FROM trades t JOIN venues v ON v.id = t.venue_id
        WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true
          AND t.price_numerator_raw IS NOT NULL AND t.price_denominator_raw IS NOT NULL
        ORDER BY t.block_number DESC, t.log_index DESC LIMIT 1`, [number(row.chain_id), string(row.token_address)]),
    ]);
    const priceRow = priceResult.rows[0] as Row | undefined;
    const fdvUsd = totalSupply !== null && row.token_decimals !== null
      ? computeFdvUsd(totalSupply, number(row.token_decimals),
        priceRow ? BigInt(string(priceRow.price_numerator_raw)) : null,
        priceRow ? BigInt(string(priceRow.price_denominator_raw)) : null,
        usdPrice?.priceUsd ?? null) : null;
    // Same math as computeFdvUsd minus the totalSupply dependency — a per-token USD price only
    // needs the quote asset's USD rate, not the full supply.
    const priceUsd = priceRow && usdPrice
      ? (Number(priceRow.price_numerator_raw) / Number(priceRow.price_denominator_raw) * usdPrice.priceUsd).toString()
      : null;

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

    return { fdvUsd, marketCapUsd: fdvUsd, priceUsd, week52High: high, week52Low: low, change1h, change1d, ...(await tvlPromise) };
  } catch {
    return { ...NULL_STATS, ...(await tvlPromise) };
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
  async function safeHead(): Promise<bigint | null> {
    const result = await pool.query(SAFE_HEAD_SQL);
    return result.rows[0]?.safe_head === null ? null : BigInt(string(result.rows[0].safe_head));
  }
  async function coverage() {
    const [sourceResult, headResult, gapResult, poolResult, phaseResult] = await Promise.all([
      pool.query('SELECT id, status, confirmed_to_block, start_block FROM sources'),
      pool.query(SAFE_HEAD_SQL),
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
    const now = new Date();
    await assertVolumeRankingAvailable(pool, now);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const cursorValue = query.cursor ? decodeVolumeCursor(query.cursor, secret, nowSeconds) : null;
    const page = await readVolumeRankingPage(pool, {
      chainId: query.chainId, platform: query.platform, status: query.status, search: query.search,
      cursor: cursorValue && {
        rankOrder: cursorValue.rankOrder, volumeUsd: cursorValue.volumeUsd, launchBlock: cursorValue.launchBlock,
        launchTxHash: cursorValue.launchTxHash, launchLogIndex: cursorValue.launchLogIndex,
      },
      limit: query.limit,
      headBlock: await safeHead(),
    });
    const nextCursor = page.nextCursor
      ? encodeVolumeCursor({ version: 2, sort: 'volume24hUsd', issuedAt: nowSeconds, ...page.nextCursor }, secret)
      : null;
    const statsByToken = await readLaunchStats(pool, page.rows.map((item) => ({ chainId: number(item.raw.chain_id), tokenAddress: string(item.raw.token_address) })));
    return {
      items: page.rows.map((item) => ({
        ...summary(item.raw, item.coverageComplete, statsForCoverage(statsByToken.get(`${number(item.raw.chain_id)}:${string(item.raw.token_address)}`), item.coverageComplete)),
        officialVolume24hUsd: item.volumeUsd,
        officialVolume24hUsdApprox: item.rankCategory === 'positive',
        officialVolume24hUsdAsOf: item.rankCategory === 'null' ? null : new Date(item.windowEnd * 1000).toISOString(),
      })),
      nextCursor,
    };
  }

  async function listLaunchesByMetric(query: LaunchListQuery): Promise<Page<LaunchSummary>> {
    const sort = query.sort ?? 'recent';
    const direction = query.direction ?? (sort === 'recent' ? 'asc' : 'desc');
    if (sort === 'volume24hUsd') await assertVolumeRankingAvailable(pool, new Date());
    const result = await readMetricRankingPage(pool, {
      sort, direction, chainId: query.chainId, platform: query.platform, status: query.status, search: query.search,
      cursor: query.cursor, limit: query.limit, headBlock: await safeHead(), since: Math.floor(Date.now() / 1000) - 86_400,
    });
    const statsByToken = await readLaunchStats(pool, result.rows.map((row) => ({ chainId: number(row.chain_id), tokenAddress: string(row.token_address) })));
    return {
      items: result.rows.map((row) => {
        const complete = Boolean(row.launch_coverage_complete);
        const item = summary(row, complete, statsForCoverage(statsByToken.get(`${number(row.chain_id)}:${string(row.token_address)}`), complete));
        if (sort !== 'volume24hUsd') return item;
        const volume = row.rank_category === 'null' || row.volume_usd === null ? null : nullableString(row.volume_usd);
        return { ...item, officialVolume24hUsd: volume, officialVolume24hUsdApprox: row.rank_category === 'positive',
          officialVolume24hUsdAsOf: volume === null || row.window_end === null ? null : new Date(number(row.window_end) * 1000).toISOString() };
      }),
      nextCursor: result.nextCursor,
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
      if (query.sort === 'volume24hUsd' && (query.direction === undefined || query.direction === 'desc')) return listLaunchesByVolume(query);
      if ((query.sort ?? 'recent') !== 'recent' || query.direction === 'desc') return listLaunchesByMetric(query);
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
        WHERE ($1::integer[] IS NULL OR l.chain_id = ANY($1))
          AND ($2::bigint IS NULL OR (l.launch_block, l.launch_tx_hash, l.launch_log_index) < ($2::bigint, $3::text, $4::integer))
          AND ($7::text IS NULL OR l.name ILIKE '%' || $7 || '%' OR l.symbol ILIKE '%' || $7 || '%')
          AND ($8::text IS NULL OR l.lifecycle_status = $8)
          AND ($10::text[] IS NULL OR l.platform = ANY($10))
        ORDER BY l.launch_block DESC, l.launch_tx_hash DESC, l.launch_log_index DESC LIMIT $5`,
      [query.chainId === undefined ? null : [query.chainId].flat(), cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null, cursor?.logIndex ?? null, query.limit + 1, since,
        query.search ?? null, query.status ?? null, head?.toString() ?? null, query.platform === undefined ? null : [query.platform].flat()]);
      const rows = result.rows as Row[];
      const statsByToken = await readLaunchStats(pool, rows.slice(0, query.limit).map((row) => ({ chainId: number(row.chain_id), tokenAddress: string(row.token_address) })));
      return page(rows, query.limit, (row) => summary(row, Boolean(row.launch_coverage_complete),
        statsForCoverage(statsByToken.get(`${number(row.chain_id)}:${string(row.token_address)}`), Boolean(row.launch_coverage_complete))));
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
      const stats = statsForCoverage((await readLaunchStats(pool, [{ chainId, tokenAddress: tokenAddress.toLowerCase() }])).get(`${chainId}:${tokenAddress.toLowerCase()}`), complete);
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
    async listTransactions(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TransactionResponse>> {
      const token = tokenAddress.toLowerCase();
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      // Fetched once regardless of branch — official rows already had this via their l.* join,
      // but pool rows never did (a pool_catalog row carries no decimals at all). One lookup for
      // the launch's own token decimals is cheap and avoids an RPC round trip per distinct pool
      // (final-review Important 3: the previous version called assetDecimals for the launch token
      // itself, redundant with this already-known, already-indexed value).
      const launchRow = (await pool.query('SELECT token_decimals FROM launches WHERE chain_id = $1 AND token_address = $2',
        [chainId, token])).rows[0] as Row | undefined;
      const tokenDecimals = launchRow ? nullableNumber(launchRow.token_decimals) : null;
      const result = await pool.query(`
        WITH merged AS (
          SELECT 'official' AS source, t.venue_id, NULL::text AS protocol, NULL::text AS pool_id,
            NULL::text AS currency0, NULL::text AS currency1,
            t.tx_hash, t.log_index, t.block_number, t.timestamp, t.side, t.activity_kind,
            t.token_amount_raw AS amount_a_raw, t.quote_amount_raw AS amount_b_raw, t.trader_address,
            l.quote_asset_address, l.quote_asset_decimals
          FROM trades t
          JOIN venues v ON v.id = t.venue_id
          JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
          WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true

          UNION ALL

          -- pt.chain_id = $1 is required (not implied by the pool_catalog join alone): without it,
          -- a token at the same address on another chain could pull that chain's pool swaps into
          -- this launch's feed (final-review Important 1).
          SELECT 'pool' AS source, NULL::text AS venue_id, pt.protocol, pt.pool_id,
            pc.currency0, pc.currency1,
            pt.tx_hash, pt.log_index, pt.block_number, pt.timestamp, NULL::text AS side, NULL::text AS activity_kind,
            pt.amount0_raw AS amount_a_raw, pt.amount1_raw AS amount_b_raw, pt.trader_address,
            NULL::text AS quote_asset_address, NULL::integer AS quote_asset_decimals
          FROM pool_trades pt
          JOIN pool_catalog pc ON pc.chain_id = pt.chain_id AND pc.protocol = pt.protocol AND pc.pool_id = pt.pool_id
          WHERE pt.chain_id = $1 AND pc.verified = true
            AND EXISTS (SELECT 1 FROM pool_members m WHERE m.chain_id = pc.chain_id AND m.protocol = pc.protocol
              AND m.pool_id = pc.pool_id AND m.token_address = $2)
            AND NOT EXISTS (SELECT 1 FROM venues ov WHERE ov.chain_id = pc.chain_id
              AND ov.kind IN ('v4_pool','v3_pool') AND ov.ref = pc.pool_id AND ov.official = true)
        )
        SELECT * FROM merged
        WHERE ($3::bigint IS NULL OR (block_number, tx_hash, log_index) < ($3::bigint, $4::text, $5::integer))
        ORDER BY block_number DESC, tx_hash DESC, log_index DESC
        LIMIT $6`,
      [chainId, token, cursor?.blockNumber.toString() ?? null, cursor?.txHash ?? null,
        cursor?.logIndex ?? null, query.limit + 1]);
      const rows = result.rows as Row[];
      const visible = rows.slice(0, query.limit);

      // Pool rows only carry raw amount0/amount1 — resolve the pool's counter (quote) asset's
      // decimals once per distinct address on this page, not once per row. The launch token's own
      // decimals (tokenDecimals, above) never needs this: only the OTHER side of a pool swap is an
      // arbitrary ERC20 with no already-known decimals.
      const distinctQuoteAddresses = [...new Set(visible
        .filter((row) => row.source === 'pool' && row.currency0 !== null)
        .map((row) => (string(row.currency0) === token ? string(row.currency1) : string(row.currency0))))];
      const decimalsByAddress = new Map<string, number | null>(
        await Promise.all(distinctQuoteAddresses.map(async (address) => [address, await assetDecimals(rpcClient, address)] as const)),
      );

      interface Interpreted { side: 'buy' | 'sell'; tokenAmountRaw: bigint; quoteAmountRaw: bigint;
        quoteAssetAddress: string | null; quoteAssetDecimals: number | null }
      function interpret(row: Row): Interpreted {
        if (row.source === 'official') {
          return { side: string(row.side) as 'buy' | 'sell', tokenAmountRaw: BigInt(string(row.amount_a_raw)),
            quoteAmountRaw: BigInt(string(row.amount_b_raw)), quoteAssetAddress: nullableString(row.quote_asset_address),
            quoteAssetDecimals: nullableNumber(row.quote_asset_decimals) };
        }
        const currency0 = nullableString(row.currency0);
        const currency1 = nullableString(row.currency1);
        const displayedIsCurrency0 = currency0 === token;
        const signed = BigInt(string(displayedIsCurrency0 ? row.amount_a_raw : row.amount_b_raw));
        const quoteSigned = BigInt(string(displayedIsCurrency0 ? row.amount_b_raw : row.amount_a_raw));
        const quoteAssetAddress = currency0 && currency1 ? (displayedIsCurrency0 ? currency1 : currency0) : null;
        // Same sign convention as the official V4 decoder (be/src/launchpads/pons/v2/v4Swaps.ts) and
        // readPoolTrades (be/src/pools/stats.ts): the trader's displayed-token balance increasing
        // (positive) means they received it, a buy — NOT the inverse (final-review Critical 1).
        return { side: signed > 0n ? 'buy' : 'sell', tokenAmountRaw: signed < 0n ? -signed : signed,
          quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned, quoteAssetAddress,
          quoteAssetDecimals: quoteAssetAddress ? decimalsByAddress.get(quoteAssetAddress) ?? null : null };
      }
      const interpreted = visible.map(interpret);

      // Resolve one verified feed per DISTINCT quote asset on this page (not per row), then value
      // each row and coalesce pending-backfill ranges per feed — generalizes listTrades' single-feed
      // coalescing (that method only ever has one quote asset per page; this one can have many,
      // since different pools can quote in different assets).
      const distinctQuoteAssets = [...new Set(interpreted.map((i) => i.quoteAssetAddress).filter((a): a is string => a !== null))];
      const feedByQuoteAsset = new Map(await Promise.all(distinctQuoteAssets.map(async (address) =>
        [address, await resolveVerifiedFeed(pool, chainId, address)] as const)));
      const valuations = await Promise.all(visible.map((row, i) => {
        const info = interpreted[i]!;
        if (info.quoteAssetDecimals === null || info.quoteAssetAddress === null) return Promise.resolve({ status: 'unavailable' as const });
        return valueTradeUsd(pool, chainId, info.quoteAssetAddress, { timestamp: number(row.timestamp),
          quoteAmountRaw: info.quoteAmountRaw, quoteAssetDecimals: info.quoteAssetDecimals,
          blockNumber: BigInt(string(row.block_number)), logIndex: number(row.log_index) });
      }));
      const pendingByFeed = new Map<string, number[]>();
      valuations.forEach((valuation, i) => {
        if (valuation.status !== 'pending') return;
        const feed = feedByQuoteAsset.get(interpreted[i]!.quoteAssetAddress ?? '');
        if (!feed) return;
        const list = pendingByFeed.get(feed.feedAddress) ?? [];
        list.push(number(visible[i]!.timestamp));
        pendingByFeed.set(feed.feedAddress, list);
      });
      await Promise.all([...pendingByFeed.entries()].map(([feedAddress, timestamps]) =>
        enqueueRoundBackfillJob(pool, chainId, feedAddress, Math.min(...timestamps) - 3600, Math.max(...timestamps) + 3600).catch(() => {})));

      return page(rows, query.limit, (row, i) => {
        const info = interpreted[i]!;
        return {
          source: row.source as 'official' | 'pool',
          venueId: nullableString(row.venue_id),
          pool: row.protocol ? { protocol: string(row.protocol) as 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2', poolId: string(row.pool_id) } : null,
          blockNumber: string(row.block_number), txHash: string(row.tx_hash), logIndex: number(row.log_index),
          timestamp: number(row.timestamp), side: info.side, activityKind: nullableString(row.activity_kind),
          tokenAmount: tokenDecimals === null ? null : formatUnits(info.tokenAmountRaw, tokenDecimals),
          quoteAmount: info.quoteAssetDecimals === null ? null : formatUnits(info.quoteAmountRaw, info.quoteAssetDecimals),
          quoteAssetAddress: info.quoteAssetAddress,
          traderAddress: string(row.trader_address),
          usdValue: valuations[i]!.status === 'priced' ? (valuations[i] as { status: 'priced'; usdValue: string }).usdValue : null,
          usdValueApprox: valuations[i]!.status === 'priced',
          usdValueStatus: valuations[i]!.status,
        };
      }) as Page<TransactionResponse>;
    },
    async listUsdCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number): Promise<{ items: readonly UsdCandleResponse[]; complete: boolean }> {
      const head = await safeHead();
      const launch = (await pool.query(`SELECT ${launchCoverageSql(3)} AS launch_coverage_complete
        FROM launches l WHERE l.chain_id = $1 AND l.token_address = $2 LIMIT 1`,
      [chainId, tokenAddress.toLowerCase(), head?.toString() ?? null])).rows[0] as Row | undefined;
      if (!launch) return { items: [], complete: false };
      const end = before ?? Math.floor(Date.now() / 1000) + 1;
      const start = Math.floor((end - 1) / intervalSeconds) * intervalSeconds - 499 * intervalSeconds;
      const rows = (await pool.query(`SELECT bucket_start, open, high, low, close, volume_usd, trade_count, computed_at
        FROM usd_candles WHERE chain_id = $1 AND token_address = $2 AND interval_seconds = $3
          AND bucket_start >= $4 AND bucket_start < $5
        ORDER BY bucket_start DESC LIMIT 500`, [chainId, tokenAddress.toLowerCase(), intervalSeconds, start, end])).rows as Row[];
      return {
        complete: Boolean(launch.launch_coverage_complete),
        items: rows.map((row) => ({
          intervalSeconds, bucketStart: number(row.bucket_start), open: string(row.open), high: string(row.high),
          low: string(row.low), close: string(row.close), volumeUsd: string(row.volume_usd), tradeCount: number(row.trade_count),
          computedAt: new Date(row.computed_at as string | Date).toISOString(),
        })),
      };
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
