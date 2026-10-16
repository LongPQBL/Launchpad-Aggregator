import type { Pool } from 'pg';
import { parseAbi, type Address } from 'viem';
import { computePriceChange } from '../market/aggregate.js';
import { computeFdvUsd, readTotalSupply } from '../market/tokenStats.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { readUsdPrice, type UsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { readPoolAmounts } from './poolAmounts.js';
import { readTvlChange } from './tvlSnapshots.js';
import { calculateTvlUsd } from '../market/tvlValue.js';
import { poolPriceInQuote, poolPriceRational, sumUsdValues, percentChange } from './valuation.js';
import { isRollupBackfilled } from '../charts/rollupState.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const MAX_RECENT_TRADES = 10_000;
const VOLUME_BUCKET_SECONDS = 3_600;

export interface PoolKey { chainId: number; protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string }
export interface PoolStats {
  poolBalances: PoolBalanceSnapshot | null;
  volume24hUsd: string | null;
  volume24hChange: string | null;
  priceInQuote: string | null;
  priceUsd: string | null;
  fdvUsd: string | null;
  tvlUsd: string | null;
  tvlChange: string | null;
  change1h: string | null;
  change1d: string | null;
  coverageStatus: string;
  lastTradeTimestamp: number | null;
}
export interface PoolBalanceSnapshot {
  displayedAmountRaw: string;
  otherAmountRaw: string;
  priceInQuote: string;
}
export interface PoolTradeResponse {
  txHash: string; logIndex: number; blockNumber: string; timestamp: number; traderAddress: string;
  side: 'buy' | 'sell'; amount0Raw: string; amount1Raw: string; priceInQuote: string | null;
  usdValue: string | null; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}

interface PoolRow { currency0: string; currency1: string; coverage_status: string; fee: number; tick_spacing: number; hooks: string; block_number: string | number }
interface TradeRow {
  amount0_raw: string; amount1_raw: string; sqrt_price_x96: string;
  timestamp: number; block_number: string; log_index: number;
}

interface TradePageRow extends TradeRow { tx_hash: string; trader_address: string }

/** Exact rolling USD volume from complete hourly rollups plus directly valued trades at the window edges. */
export async function readPoolRollingVolume(pool: Pool, key: PoolKey,
  window: { seconds: number; end: number; rpcClient?: UsdPriceClient }): Promise<string | null> {
  if (!Number.isSafeInteger(window.seconds) || window.seconds < 1 || !Number.isSafeInteger(window.end)) {
    throw new Error('Invalid pool volume window');
  }
  const start = window.end - window.seconds;
  const found = await pool.query(`SELECT currency0,currency1,coverage_status,block_number FROM pool_catalog
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true`,
  [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const catalog = found.rows[0] as (Pick<PoolRow, 'currency0' | 'currency1' | 'coverage_status' | 'block_number'>) | undefined;
  if (!catalog || catalog.coverage_status !== 'caught_up') return null;
  const indexedFrom = (await pool.query('SELECT indexed_from_block FROM envio_chain_progress WHERE chain_id=$1', [key.chainId])).rows[0]?.indexed_from_block;
  if (indexedFrom !== null && indexedFrom !== undefined && BigInt(String(catalog.block_number)) < BigInt(String(indexedFrom))) return null;
  if (!await isRollupBackfilled(pool, 'pool_volume')) return null;

  const [decimals0, decimals1] = await Promise.all([
    assetDecimals(window.rpcClient, catalog.currency0), assetDecimals(window.rpcClient, catalog.currency1),
  ]);
  const sides = [
    { address: catalog.currency1, decimals: decimals1, amount: 'amount1_raw' as const, side: 1 as const },
    { address: catalog.currency0, decimals: decimals0, amount: 'amount0_raw' as const, side: 0 as const },
  ];
  let selected: (typeof sides)[number] | null = null;
  for (const side of sides) {
    if (side.decimals !== null && await resolveVerifiedFeed(pool, key.chainId, side.address)) { selected = side; break; }
  }
  if (!selected || selected.decimals === null) return null;

  const firstFullHour = Math.ceil(start / VOLUME_BUCKET_SECONDS) * VOLUME_BUCKET_SECONDS;
  const afterLastFullHour = Math.floor(window.end / VOLUME_BUCKET_SECONDS) * VOLUME_BUCKET_SECONDS;
  const ranges: Array<[number, number]> = [];
  if (start < Math.min(firstFullHour, window.end)) ranges.push([start, Math.min(firstFullHour, window.end)]);
  if (Math.max(firstFullHour, afterLastFullHour) < window.end) ranges.push([Math.max(firstFullHour, afterLastFullHour), window.end]);
  const directValues: string[] = [];
  for (const [from, to] of ranges) {
    const result = await pool.query(`SELECT amount0_raw,amount1_raw,sqrt_price_x96,timestamp,block_number,log_index
      FROM pool_trades WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp >= $4 AND timestamp < $5
      ORDER BY block_number,log_index LIMIT $6`,
    [key.chainId, key.protocol, key.poolId.toLowerCase(), from, to, MAX_RECENT_TRADES + 1]);
    const edgeTrades = result.rows as TradeRow[];
    if (edgeTrades.length > MAX_RECENT_TRADES) return null;
    for (const row of edgeTrades) {
      const amount = BigInt(row[selected.amount]);
      const valued = await valueTradeUsd(pool, key.chainId, selected.address, {
        timestamp: Number(row.timestamp), quoteAmountRaw: amount < 0n ? -amount : amount,
        quoteAssetDecimals: selected.decimals, blockNumber: BigInt(row.block_number), logIndex: Number(row.log_index),
      });
      if (valued.status !== 'priced') return null;
      directValues.push(valued.usdValue);
    }
  }

  let bucketValue = '0';
  let dirtyBucketValue = '0';
  if (firstFullHour < afterLastFullHour) {
    const dirty = await pool.query(`SELECT bucket_start FROM (
      SELECT DISTINCT (bucket_start / 3600::bigint) * 3600::bigint AS bucket_start
      FROM pool_candle_dirty_buckets WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3
        AND bucket_start >= $4 AND bucket_start < $5
    ) d ORDER BY bucket_start DESC LIMIT 21`,
    [key.chainId, key.protocol, key.poolId.toLowerCase(), firstFullHour, afterLastFullHour]);
    const dirtyHours = dirty.rows.map((row) => Number(row.bucket_start));
    if (dirtyHours.length > 20) return null;
    const bucket = await pool.query(`SELECT coalesce(sum(usd_scaled${selected.side}),0)::text AS scaled,
        coalesce(sum(unpriced${selected.side}),0)::int AS unpriced
      FROM pool_volume_buckets b WHERE b.chain_id=$1 AND b.protocol=$2 AND b.pool_id=$3 AND b.interval_seconds=3600
        AND b.bucket_start >= $4 AND b.bucket_start < $5
        AND NOT EXISTS (SELECT 1 FROM pool_candle_dirty_buckets d WHERE d.chain_id=b.chain_id AND d.protocol=b.protocol
          AND d.pool_id=b.pool_id AND d.bucket_start >= b.bucket_start AND d.bucket_start < b.bucket_start+3600)`,
    [key.chainId, key.protocol, key.poolId.toLowerCase(), firstFullHour, afterLastFullHour]);
    const row = bucket.rows[0];
    if (!row || Number(row.unpriced) > 0) return null;
    const scaled = String(row.scaled);
    bucketValue = (await pool.query('SELECT ($1::numeric / power(10::numeric,$2::int))::text AS value',
      [scaled, selected.decimals])).rows[0]?.value ?? '0';
    if (dirtyHours.length > 0) {
      const live = await pool.query(`WITH valued AS (
        SELECT CASE WHEN r.answer_raw IS NULL OR pt.timestamp-r.updated_at < 0 OR pt.timestamp-r.updated_at > 86400 THEN NULL
          ELSE abs(pt.amount${selected.side}_raw::numeric) * r.answer_raw::numeric / power(10::numeric, r.decimals+$5::int) END AS usd
        FROM pool_trades pt
        JOIN unnest($4::bigint[]) AS d(bucket_start) ON pt.timestamp >= d.bucket_start AND pt.timestamp < d.bucket_start+3600
        LEFT JOIN quote_usd_feeds f ON f.chain_id=pt.chain_id AND f.quote_asset_address=$6 AND f.verification_status='verified'
        LEFT JOIN LATERAL (SELECT answer_raw, decimals, updated_at FROM quote_usd_price_rounds
          WHERE chain_id=f.chain_id AND feed_address=f.feed_address AND (block_number,log_index) <= (pt.block_number,pt.log_index)
          ORDER BY block_number DESC,log_index DESC LIMIT 1) r ON true
        WHERE pt.chain_id=$1 AND pt.protocol=$2 AND pt.pool_id=$3
      ) SELECT coalesce(sum(usd),0)::text AS value, (count(*) FILTER (WHERE usd IS NULL))::int AS unpriced FROM valued`,
      [key.chainId, key.protocol, key.poolId.toLowerCase(), dirtyHours, selected.decimals, selected.address]);
      if (Number(live.rows[0]?.unpriced) > 0) return null;
      dirtyBucketValue = String(live.rows[0]?.value ?? '0');
    }
  }
  return sumUsdValues([...directValues, bucketValue, dirtyBucketValue]);
}

function decodeTradeCursor(cursor: string): { blockNumber: bigint; logIndex: number; txHash: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string'
      || !/^\d+$/.test(value[0]) || !Number.isSafeInteger(value[1]) || value[1] < 0
      || typeof value[2] !== 'string' || !/^0x[0-9a-f]{64}$/.test(value[2])) throw new Error('bad');
    return { blockNumber: BigInt(value[0]), logIndex: value[1] as number, txHash: value[2] };
  } catch { throw new Error('Invalid pool trade cursor'); }
}

/** Canonical descending event order, with exact per-trade historical USD status. */
export async function readPoolTrades(pool: Pool, key: PoolKey, displayedToken: string,
  query: { limit: number; cursor?: string; rpcClient?: UsdPriceClient },
): Promise<{ items: PoolTradeResponse[]; nextCursor: string | null }> {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error('Invalid pool trade limit');
  const found = await pool.query('SELECT currency0,currency1 FROM pool_catalog WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true',
    [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const catalog = found.rows[0] as Pick<PoolRow, 'currency0' | 'currency1'> | undefined;
  if (!catalog) throw new Error('Pool not found');
  const displayed = displayedToken.toLowerCase();
  if (displayed !== catalog.currency0 && displayed !== catalog.currency1) throw new Error('Token is not in pool');
  const displayedIsCurrency0 = displayed === catalog.currency0;
  const [decimals0, decimals1] = await Promise.all([
    assetDecimals(query.rpcClient, catalog.currency0), assetDecimals(query.rpcClient, catalog.currency1),
  ]);
  const sides = [
    { address: catalog.currency1, decimals: decimals1, amount: 'amount1_raw' as const },
    { address: catalog.currency0, decimals: decimals0, amount: 'amount0_raw' as const },
  ];
  const verified = await Promise.all(sides.map(async (side) => ({ ...side,
    feed: await resolveVerifiedFeed(pool, key.chainId, side.address) })));
  const pricedSide = verified.find((side) => side.feed && side.decimals !== null);
  const cursor = query.cursor ? decodeTradeCursor(query.cursor) : null;
  const params: unknown[] = [key.chainId, key.protocol, key.poolId.toLowerCase()];
  const boundary = cursor ? `AND (block_number,log_index,tx_hash) < ($4::bigint,$5::integer,$6::text)` : '';
  if (cursor) params.push(cursor.blockNumber.toString(), cursor.logIndex, cursor.txHash);
  params.push(query.limit + 1);
  const result = await pool.query(`SELECT tx_hash,log_index,block_number,timestamp,trader_address,
    amount0_raw,amount1_raw,sqrt_price_x96 FROM pool_trades
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 ${boundary}
    ORDER BY block_number DESC,log_index DESC,tx_hash DESC LIMIT $${params.length}`, params);
  const rows = result.rows as TradePageRow[];
  const items: PoolTradeResponse[] = [];
  for (const row of rows.slice(0, query.limit)) {
    const signed = BigInt(displayedIsCurrency0 ? row.amount0_raw : row.amount1_raw);
    const quoteSigned = pricedSide ? BigInt(row[pricedSide.amount]) : 0n;
    const valued = pricedSide ? await valueTradeUsd(pool, key.chainId, pricedSide.address, {
      timestamp: Number(row.timestamp), quoteAmountRaw: quoteSigned < 0n ? -quoteSigned : quoteSigned,
      quoteAssetDecimals: pricedSide.decimals, blockNumber: BigInt(row.block_number), logIndex: Number(row.log_index),
    }) : { status: 'unavailable' as const };
    items.push({ txHash: row.tx_hash, logIndex: Number(row.log_index), blockNumber: String(row.block_number),
      // Same convention as the official V4 decoder (be/src/launchpads/pons/v2/v4Swaps.ts):
      // the trader's displayed-token balance increasing (positive) means they received it, a buy.
      timestamp: Number(row.timestamp), traderAddress: row.trader_address, side: signed > 0n ? 'buy' : 'sell',
      amount0Raw: row.amount0_raw, amount1Raw: row.amount1_raw,
      priceInQuote: poolPriceInQuote(BigInt(row.sqrt_price_x96), displayedIsCurrency0 ? decimals0 : decimals1,
        displayedIsCurrency0 ? decimals1 : decimals0, displayedIsCurrency0),
      usdValue: valued.status === 'priced' ? valued.usdValue : null, usdValueStatus: valued.status });
  }
  const last = rows.length > query.limit ? rows[query.limit - 1] : null;
  return { items, nextCursor: last ? Buffer.from(JSON.stringify([
    String(last.block_number), Number(last.log_index), String(last.tx_hash),
  ])).toString('base64url') : null };
}

// A token's decimals never change, so a successful read is remembered (per chain and address); a failed read is not, and is retried next time.
// The pending read itself is shared too: a list of pools asks for the same token's decimals from many rows at once, and each of those asks used
// to become its own RPC call.
const decimalsCache = new Map<string, Promise<number | null>>();
/** Test-only: forget the remembered decimals (module state otherwise survives between tests of one file). */
export function __resetAssetDecimalsCacheForTests(): void { decimalsCache.clear(); }

export async function assetDecimals(client: UsdPriceClient | undefined, address: string): Promise<number | null> {
  if (address === ZERO_ADDRESS) return 18;
  if (!client) return null;
  const key = `${client.chain?.id ?? 0}:${address.toLowerCase()}`;
  const known = decimalsCache.get(key);
  if (known) return known;
  const pending = (async (): Promise<number | null> => {
    try {
      const value = await client.readContract({ address: address as Address, abi: erc20DecimalsAbi, functionName: 'decimals' });
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
    } catch { return null; }
  })();
  decimalsCache.set(key, pending);
  void pending.then((value) => { if (value === null && decimalsCache.get(key) === pending) decimalsCache.delete(key); });
  return pending;
}

// Both sides' amounts and the spot price of any pool type: the V4 reserves lens (pool principal), a V3 pool's token balances (what it holds,
// uncollected fees included) or a V2 pair's reserves. `quoteUsd` values the quote side; without it only the balances come back.
async function readPoolSnapshot(client: UsdPriceClient | undefined, key: PoolKey, catalog: PoolRow, displayedIsCurrency0: boolean,
  displayedDecimals: number | null, quoteDecimals: number | null, quoteUsd: number | null): Promise<{
    poolBalances: PoolBalanceSnapshot | null; tvlUsd: string | null; sqrtPriceX96: bigint | null; readFailed: boolean;
  }> {
  if (displayedDecimals === null || quoteDecimals === null || !client) return { poolBalances: null, tvlUsd: null, sqrtPriceX96: null, readFailed: false };
  let readFailed = false;
  const amounts = await readPoolAmounts(client, { protocol: key.protocol, poolId: key.poolId, currency0: catalog.currency0, currency1: catalog.currency1,
    fee: catalog.fee, tick_spacing: catalog.tick_spacing, hooks: catalog.hooks }, undefined, () => { readFailed = true; });
  if (!amounts) return { poolBalances: null, tvlUsd: null, sqrtPriceX96: null, readFailed };
  try {
    const { blockNumber, amount0, amount1, sqrtPriceX96 } = amounts;
    const priceInQuote = poolPriceInQuote(sqrtPriceX96, displayedDecimals, quoteDecimals, displayedIsCurrency0, 100);
    const poolBalances = priceInQuote === null ? null : {
      displayedAmountRaw: (displayedIsCurrency0 ? amount0 : amount1).toString(),
      otherAmountRaw: (displayedIsCurrency0 ? amount1 : amount0).toString(),
      priceInQuote,
    };
    const tvlUsd = quoteUsd === null ? null : calculateTvlUsd({
      tokenRaw: displayedIsCurrency0 ? amount0 : amount1,
      quoteRaw: displayedIsCurrency0 ? amount1 : amount0,
      blockNumber, basis: key.protocol === 'uniswap_v4' ? 'pool_principal' : 'pool_custody', sqrtPriceX96,
      tokenIsCurrency0: displayedIsCurrency0,
    }, quoteDecimals, displayedDecimals, quoteUsd);
    return { poolBalances, tvlUsd, sqrtPriceX96, readFailed };
  } catch { return { poolBalances: null, tvlUsd: null, sqrtPriceX96: null, readFailed: false }; }
}

/** Read only this pool's swaps. An unpriced positive trade makes 24h USD volume unavailable. */
export async function readPoolStats(pool: Pool, key: PoolKey, displayedToken: string, asOf: number,
  options: { rpcClient?: UsdPriceClient; createdTimestamp?: number | null; previousTvlUsd?: string | null;
    onPreviousTvlUsed?: () => void } = {}): Promise<PoolStats> {
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('Invalid pool statistics time');
  const found = await pool.query(`SELECT currency0, currency1, coverage_status, fee, tick_spacing, hooks, block_number FROM pool_catalog
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true`, [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const catalog = found.rows[0] as PoolRow | undefined;
  if (!catalog) throw new Error('Pool not found');
  const displayed = displayedToken.toLowerCase();
  if (displayed !== catalog.currency0 && displayed !== catalog.currency1) throw new Error('Token is not in pool');
  const displayedIsCurrency0 = displayed === catalog.currency0;
  const quoteAddress = displayedIsCurrency0 ? catalog.currency1 : catalog.currency0;
  const [decimals0, decimals1] = await Promise.all([
    assetDecimals(options.rpcClient, catalog.currency0), assetDecimals(options.rpcClient, catalog.currency1),
  ]);
  const displayedDecimals = displayedIsCurrency0 ? decimals0 : decimals1;
  const quoteDecimals = displayedIsCurrency0 ? decimals1 : decimals0;
  const recent = await pool.query(`SELECT amount0_raw, amount1_raw, sqrt_price_x96, timestamp, block_number, log_index
    FROM pool_trades WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp >= $4 AND timestamp <= $5
    ORDER BY block_number ASC, log_index ASC LIMIT $6`,
  [key.chainId, key.protocol, key.poolId.toLowerCase(), asOf - 86_400, asOf, MAX_RECENT_TRADES + 1]);
  const rows = recent.rows as TradeRow[];
  const last = rows.at(-1);
  const complete = catalog.coverage_status === 'caught_up' && rows.length <= MAX_RECENT_TRADES;
  // A pool created before the first block Envio indexes has no complete swap history: its volume is unknown, not $0.
  const indexedFrom = (await pool.query('SELECT indexed_from_block FROM envio_chain_progress WHERE chain_id = $1', [key.chainId])).rows[0]?.indexed_from_block;
  const swapHistoryComplete = indexedFrom === null || indexedFrom === undefined || BigInt(String(catalog.block_number)) >= BigInt(String(indexedFrom));
  const quoteFeed = await resolveVerifiedFeed(pool, key.chainId, quoteAddress);
  let quotePriceReadFailed = false;
  let currentQuoteUsd: UsdPrice | null = null;
  if (options.rpcClient && quoteFeed) {
    try { currentQuoteUsd = await readUsdPrice(pool, options.rpcClient, key.chainId, quoteAddress, () => asOf * 1000); }
    catch { quotePriceReadFailed = true; }
  }
  let poolSnapshot = await readPoolSnapshot(options.rpcClient, key, catalog, displayedIsCurrency0, displayedDecimals, quoteDecimals,
    currentQuoteUsd?.priceUsd ?? null);
  // TVL only needs one side with a verified USD feed. When the quote has none (a pool of two launched tokens read from the one
  // without a feed's side, say), value the pool through the other side instead of leaving it unavailable.
  let alternateQuoteReadFailed = false;
  if (poolSnapshot.tvlUsd === null && poolSnapshot.poolBalances !== null && currentQuoteUsd === null
    && options.rpcClient && (await resolveVerifiedFeed(pool, key.chainId, displayed))) {
    let displayedUsd: UsdPrice | null = null;
    try { displayedUsd = await readUsdPrice(pool, options.rpcClient, key.chainId, displayed, () => asOf * 1000); }
    catch { alternateQuoteReadFailed = true; }
    if (displayedUsd) {
      const swapped = await readPoolSnapshot(options.rpcClient, key, catalog, !displayedIsCurrency0, quoteDecimals, displayedDecimals, displayedUsd.priceUsd);
      poolSnapshot = { poolBalances: poolSnapshot.poolBalances, tvlUsd: swapped.tvlUsd, sqrtPriceX96: poolSnapshot.sqrtPriceX96,
        readFailed: poolSnapshot.readFailed || swapped.readFailed };
    }
  }

  // Current price and TVL use one chain read even while Envio is backfilling history. A DB trade is a fallback only when
  // history is complete; otherwise it may be an arbitrary old price from an unfinished backfill.
  const currentSqrt = poolSnapshot.sqrtPriceX96 ?? (complete && last ? BigInt(last.sqrt_price_x96) : null);
  const priceInQuote = currentSqrt !== null ? poolPriceInQuote(currentSqrt, displayedDecimals, quoteDecimals, displayedIsCurrency0, 100) : null;
  const priceUsd = priceInQuote !== null && currentQuoteUsd
    ? (Number(priceInQuote) * currentQuoteUsd.priceUsd).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 100 })
    : null;
  const supply = options.rpcClient && displayed !== ZERO_ADDRESS
    ? await readTotalSupply(options.rpcClient, displayed as Address) : null;
  const priceRational = currentSqrt !== null ? poolPriceRational(currentSqrt, displayedDecimals, quoteDecimals,
    displayedIsCurrency0) : null;
  const fdvUsd = supply !== null && displayedDecimals !== null
    ? computeFdvUsd(supply, displayedDecimals, priceRational?.numerator ?? null, priceRational?.denominator ?? null,
      currentQuoteUsd?.priceUsd ?? null) : null;

  const tvlChange = complete && key.protocol === 'uniswap_v4'
    ? await readTvlChange(pool, key, quoteAddress, poolSnapshot.tvlUsd, asOf, { createdTimestamp: options.createdTimestamp }) : null;

  const volume24hUsd = catalog.coverage_status === 'caught_up' && swapHistoryComplete
    ? await readPoolRollingVolume(pool, key, { seconds: 86_400, end: asOf, rpcClient: options.rpcClient }) : null;

  // Previous 24h window ([asOf-48h, asOf-24h)), for the "vs 24h ago" change. Unavailable (null)
  // if it is too large to value completely or any trade in it is unpriced — never treated as zero.
  let volume24hChange: string | null = null;
  if (volume24hUsd !== null) {
    const previousVolumeUsd = await readPoolRollingVolume(pool, key, {
      seconds: 86_400, end: asOf - 86_400, rpcClient: options.rpcClient,
    });
    volume24hChange = previousVolumeUsd === null ? null : percentChange(volume24hUsd, previousVolumeUsd);
  }

  const priorTrade = complete ? await pool.query(`SELECT sqrt_price_x96, timestamp FROM pool_trades
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp < $4
    ORDER BY timestamp DESC, block_number DESC, log_index DESC LIMIT 1`,
  [key.chainId, key.protocol, key.poolId.toLowerCase(), asOf - 86_400]) : null;
  const pricePoints = complete && displayedDecimals !== null && quoteDecimals !== null
    ? [...(priorTrade?.rows as TradeRow[] ?? []), ...rows].map((row) => ({ timestamp: Number(row.timestamp), price: poolPriceInQuote(
      BigInt(row.sqrt_price_x96), displayedDecimals, quoteDecimals, displayedIsCurrency0),
    })).filter((row): row is { timestamp: number; price: string } => row.price !== null) : [];
  // A pool whose whole swap history is indexed and has no swap at all has had no price movement: 0, not unknown.
  const neverSwapped = complete && swapHistoryComplete && displayedDecimals !== null && quoteDecimals !== null
    && pricePoints.length === 0 ? '0' : null;
  const tvlReadFailed = poolSnapshot.readFailed || quotePriceReadFailed || alternateQuoteReadFailed;
  if (poolSnapshot.tvlUsd === null && tvlReadFailed && options.previousTvlUsd !== null && options.previousTvlUsd !== undefined) {
    options.onPreviousTvlUsed?.();
  }
  return {
    poolBalances: poolSnapshot.poolBalances,
    volume24hUsd, volume24hChange, priceInQuote, priceUsd,
    fdvUsd, tvlUsd: poolSnapshot.tvlUsd ?? (tvlReadFailed
      ? options.previousTvlUsd ?? null : null), tvlChange,
    change1h: complete ? computePriceChange(pricePoints, asOf, 3600, options.createdTimestamp ?? null) ?? neverSwapped : null,
    change1d: complete ? computePriceChange(pricePoints, asOf, 86400, options.createdTimestamp ?? null) ?? neverSwapped : null,
    coverageStatus: catalog.coverage_status, lastTradeTimestamp: last ? Number(last.timestamp) : null,
  };
}
