import type { Pool } from 'pg';
import { parseAbi, type Address } from 'viem';
import { computePriceChange } from '../market/aggregate.js';
import { computeFdvUsd, readTotalSupply } from '../market/tokenStats.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { readLensSnapshot } from './lens.js';
import { readTvlChange } from './tvlSnapshots.js';
import { calculateTvlUsd } from '../market/tvlValue.js';
import { poolPriceInQuote, poolPriceRational, sumUsdValues, percentChange } from './valuation.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const MAX_RECENT_TRADES = 10_000;

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

interface PoolRow { currency0: string; currency1: string; coverage_status: string; fee: number; tick_spacing: number; hooks: string }
interface TradeRow {
  amount0_raw: string; amount1_raw: string; sqrt_price_x96: string;
  timestamp: number; block_number: string; log_index: number;
}

interface TradePageRow extends TradeRow { tx_hash: string; trader_address: string }

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

export async function assetDecimals(client: UsdPriceClient | undefined, address: string): Promise<number | null> {
  if (address === ZERO_ADDRESS) return 18;
  if (!client) return null;
  try {
    const value = await client.readContract({ address: address as Address, abi: erc20DecimalsAbi, functionName: 'decimals' });
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
  } catch { return null; }
}

async function readPoolSnapshot(client: UsdPriceClient | undefined, catalog: PoolRow, displayedIsCurrency0: boolean,
  displayedDecimals: number | null, quoteDecimals: number | null, quoteUsd: number | null): Promise<{
    poolBalances: PoolBalanceSnapshot | null; tvlUsd: string | null;
  }> {
  if (displayedDecimals === null || quoteDecimals === null) return { poolBalances: null, tvlUsd: null };
  const lens = await readLensSnapshot(client, catalog);
  if (!lens) return { poolBalances: null, tvlUsd: null };
  try {
    const { blockNumber, coreAmount0, coreAmount1, sqrtPriceX96 } = lens;
    const priceInQuote = poolPriceInQuote(sqrtPriceX96, displayedDecimals, quoteDecimals, displayedIsCurrency0, 100);
    const poolBalances = priceInQuote === null ? null : {
      displayedAmountRaw: (displayedIsCurrency0 ? coreAmount0 : coreAmount1).toString(),
      otherAmountRaw: (displayedIsCurrency0 ? coreAmount1 : coreAmount0).toString(),
      priceInQuote,
    };
    const tvlUsd = quoteUsd === null ? null : calculateTvlUsd({
      tokenRaw: displayedIsCurrency0 ? coreAmount0 : coreAmount1,
      quoteRaw: displayedIsCurrency0 ? coreAmount1 : coreAmount0,
      blockNumber, basis: 'pool_principal', sqrtPriceX96,
      tokenIsCurrency0: displayedIsCurrency0,
    }, quoteDecimals, displayedDecimals, quoteUsd);
    return { poolBalances, tvlUsd };
  } catch { return { poolBalances: null, tvlUsd: null }; }
}

/** Read only this pool's swaps. An unpriced positive trade makes 24h USD volume unavailable. */
export async function readPoolStats(pool: Pool, key: PoolKey, displayedToken: string, asOf: number,
  options: { rpcClient?: UsdPriceClient; createdTimestamp?: number | null } = {}): Promise<PoolStats> {
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('Invalid pool statistics time');
  const found = await pool.query(`SELECT currency0, currency1, coverage_status, fee, tick_spacing, hooks FROM pool_catalog
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
  const priceInQuote = last ? poolPriceInQuote(BigInt(last.sqrt_price_x96), displayedDecimals, quoteDecimals,
    displayedIsCurrency0) : null;
  const quoteFeed = await resolveVerifiedFeed(pool, key.chainId, quoteAddress);
  const currentQuoteUsd = options.rpcClient && quoteFeed
    ? await readUsdPrice(pool, options.rpcClient, quoteAddress, () => asOf * 1000).catch(() => null) : null;
  const priceUsd = priceInQuote !== null && currentQuoteUsd
    ? (Number(priceInQuote) * currentQuoteUsd.priceUsd).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 100 })
    : null;
  const supply = options.rpcClient && displayed !== ZERO_ADDRESS
    ? await readTotalSupply(options.rpcClient, displayed as Address) : null;
  const priceRational = last ? poolPriceRational(BigInt(last.sqrt_price_x96), displayedDecimals, quoteDecimals,
    displayedIsCurrency0) : null;
  const fdvUsd = supply !== null && displayedDecimals !== null
    ? computeFdvUsd(supply, displayedDecimals, priceRational?.numerator ?? null, priceRational?.denominator ?? null,
      currentQuoteUsd?.priceUsd ?? null) : null;
  const poolSnapshot = key.protocol === 'uniswap_v4'
    ? await readPoolSnapshot(options.rpcClient, catalog, displayedIsCurrency0, displayedDecimals, quoteDecimals,
      currentQuoteUsd?.priceUsd ?? null)
    : { poolBalances: null, tvlUsd: null };

  const tvlChange = complete && key.protocol === 'uniswap_v4'
    ? await readTvlChange(pool, key, quoteAddress, poolSnapshot.tvlUsd, asOf, { createdTimestamp: options.createdTimestamp }) : null;

  const sides = [
    { address: catalog.currency1, decimals: decimals1, amount: 'amount1_raw' as const },
    { address: catalog.currency0, decimals: decimals0, amount: 'amount0_raw' as const },
  ];
  const verifiedSides = complete ? await Promise.all(sides.map(async (side) => ({ ...side,
    feed: await resolveVerifiedFeed(pool, key.chainId, side.address) }))) : [];
  const pricedSide = verifiedSides.find((side) => side.feed && side.decimals !== null);
  const sumVolumeUsd = async (windowRows: readonly TradeRow[]): Promise<string | null> => {
    if (windowRows.length === 0) return '0';
    if (!pricedSide) return null;
    const pricedValues: string[] = [];
    for (const row of windowRows) {
      const signed = BigInt(row[pricedSide.amount]);
      const result = await valueTradeUsd(pool, key.chainId, pricedSide.address, {
        timestamp: Number(row.timestamp), quoteAmountRaw: signed < 0n ? -signed : signed,
        quoteAssetDecimals: pricedSide.decimals, blockNumber: BigInt(row.block_number), logIndex: Number(row.log_index),
      });
      if (result.status !== 'priced') return null;
      pricedValues.push(result.usdValue);
    }
    return sumUsdValues(pricedValues);
  };
  const volume24hUsd = complete ? await sumVolumeUsd(rows) : null;

  // Previous 24h window ([asOf-48h, asOf-24h)), for the "vs 24h ago" change. Unavailable (null)
  // if it is too large to value completely or any trade in it is unpriced — never treated as zero.
  let volume24hChange: string | null = null;
  if (volume24hUsd !== null) {
    const previous = await pool.query(`SELECT amount0_raw, amount1_raw, sqrt_price_x96, timestamp, block_number, log_index
      FROM pool_trades WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND timestamp >= $4 AND timestamp < $5
      ORDER BY block_number ASC, log_index ASC LIMIT $6`,
    [key.chainId, key.protocol, key.poolId.toLowerCase(), asOf - 172_800, asOf - 86_400, MAX_RECENT_TRADES + 1]);
    const previousRows = previous.rows as TradeRow[];
    const previousVolumeUsd = previousRows.length <= MAX_RECENT_TRADES ? await sumVolumeUsd(previousRows) : null;
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
  return {
    poolBalances: poolSnapshot.poolBalances,
    volume24hUsd, volume24hChange, priceInQuote: complete ? priceInQuote : null, priceUsd: complete ? priceUsd : null,
    fdvUsd: complete ? fdvUsd : null, tvlUsd: complete ? poolSnapshot.tvlUsd : null, tvlChange,
    change1h: complete ? computePriceChange(pricePoints, asOf, 3600, options.createdTimestamp ?? null) : null,
    change1d: complete ? computePriceChange(pricePoints, asOf, 86400, options.createdTimestamp ?? null) : null,
    coverageStatus: catalog.coverage_status, lastTradeTimestamp: last ? Number(last.timestamp) : null,
  };
}
