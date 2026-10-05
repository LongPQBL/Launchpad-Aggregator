import type { Pool } from 'pg';
import { parseAbi, type Address } from 'viem';
import { computePriceChange } from '../market/aggregate.js';
import { computeFdvUsd, readTotalSupply } from '../market/tokenStats.js';
import { resolveVerifiedFeed } from '../market/quotePricing/feedRegistry.js';
import { valueTradeUsd } from '../market/quotePricing/tradeValuation.js';
import { readUsdPrice, type UsdPriceClient } from '../market/usdPricing.js';
import { calculateTvlUsd } from '../market/tvlValue.js';
import { poolPriceInQuote, sumUsdValues } from './valuation.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const RESERVES_LENS = '0x0000001b173C3bbF3984D417d8614E3eed34865B' as Address;
const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct PoolTVL { uint256 coreAmount0; uint256 coreAmount1; uint256 hookReserves0; uint256 hookReserves1; uint256 hookEffective0; uint256 hookEffective1; uint160 sqrtPriceX96; int24 tick; uint128 activeLiquidity; uint256 blockNumber; address statsProvider; uint16 hookPermissions; bool hasCustomAccounting; uint8 statsStatus; }',
  'function getPoolTVL(address manager, PoolKey key) view returns (PoolTVL result)',
]);
const MAX_RECENT_TRADES = 10_000;

export interface PoolKey { chainId: number; protocol: 'uniswap_v4'; poolId: string }
export interface PoolStats {
  volume24hUsd: string | null;
  priceInQuote: string | null;
  priceUsd: string | null;
  fdvUsd: string | null;
  tvlUsd: string | null;
  change1h: string | null;
  change1d: string | null;
  coverageStatus: string;
  lastTradeTimestamp: number | null;
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
      timestamp: Number(row.timestamp), traderAddress: row.trader_address, side: signed < 0n ? 'buy' : 'sell',
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

async function poolTvlUsd(client: UsdPriceClient | undefined, catalog: PoolRow, displayedIsCurrency0: boolean,
  displayedDecimals: number | null, quoteDecimals: number | null, quoteUsd: number | null): Promise<string | null> {
  if (!client?.getBlockNumber || displayedDecimals === null || quoteDecimals === null || quoteUsd === null) return null;
  try {
    const blockNumber = await client.getBlockNumber();
    const result = await client.readContract({ address: RESERVES_LENS, abi: lensAbi, functionName: 'getPoolTVL',
      args: [POOL_MANAGER, { currency0: catalog.currency0 as Address, currency1: catalog.currency1 as Address,
        fee: catalog.fee, tickSpacing: catalog.tick_spacing, hooks: catalog.hooks as Address }],
      blockNumber, gas: 30_000_000n });
    if (!result || typeof result !== 'object' || !('coreAmount0' in result) || !('coreAmount1' in result)
      || !('sqrtPriceX96' in result) || !('hasCustomAccounting' in result)
      || typeof result.coreAmount0 !== 'bigint' || typeof result.coreAmount1 !== 'bigint'
      || typeof result.sqrtPriceX96 !== 'bigint' || result.coreAmount0 < 0n || result.coreAmount1 < 0n
      || result.sqrtPriceX96 <= 0n || result.hasCustomAccounting !== false) return null;
    return calculateTvlUsd({ tokenRaw: displayedIsCurrency0 ? result.coreAmount0 : result.coreAmount1,
      quoteRaw: displayedIsCurrency0 ? result.coreAmount1 : result.coreAmount0,
      blockNumber, basis: 'pool_principal', sqrtPriceX96: result.sqrtPriceX96,
      tokenIsCurrency0: displayedIsCurrency0 }, quoteDecimals, displayedDecimals, quoteUsd);
  } catch { return null; }
}

/** Read only this pool's swaps. An unpriced positive trade makes 24h USD volume unavailable. */
export async function readPoolStats(pool: Pool, key: PoolKey, displayedToken: string, asOf: number,
  options: { rpcClient?: UsdPriceClient } = {}): Promise<PoolStats> {
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
    ? (Number(priceInQuote) * currentQuoteUsd.priceUsd).toString() : null;
  const supply = options.rpcClient && displayed !== ZERO_ADDRESS
    ? await readTotalSupply(options.rpcClient, displayed as Address) : null;
  const fdvUsd = supply !== null && displayedDecimals !== null
    ? computeFdvUsd(supply, displayedDecimals, priceInQuote, currentQuoteUsd?.priceUsd ?? null) : null;
  const tvlUsd = await poolTvlUsd(options.rpcClient, catalog, displayedIsCurrency0, displayedDecimals,
    quoteDecimals, currentQuoteUsd?.priceUsd ?? null);

  let volume24hUsd: string | null = complete ? '0' : null;
  if (complete && rows.length > 0) {
    const sides = [
      { address: catalog.currency1, decimals: decimals1, amount: 'amount1_raw' as const },
      { address: catalog.currency0, decimals: decimals0, amount: 'amount0_raw' as const },
    ];
    const verified = await Promise.all(sides.map(async (side) => ({ ...side,
      feed: await resolveVerifiedFeed(pool, key.chainId, side.address) })));
    const pricedSide = verified.find((side) => side.feed && side.decimals !== null);
    if (!pricedSide) volume24hUsd = null;
    else {
      const pricedValues: string[] = [];
      for (const row of rows) {
        const signed = BigInt(row[pricedSide.amount]);
        const result = await valueTradeUsd(pool, key.chainId, pricedSide.address, {
          timestamp: Number(row.timestamp), quoteAmountRaw: signed < 0n ? -signed : signed,
          quoteAssetDecimals: pricedSide.decimals, blockNumber: BigInt(row.block_number), logIndex: Number(row.log_index),
        });
        if (result.status !== 'priced') { volume24hUsd = null; break; }
        pricedValues.push(result.usdValue);
      }
      if (volume24hUsd !== null) volume24hUsd = sumUsdValues(pricedValues);
    }
  }

  const pricePoints = complete && displayedDecimals !== null && quoteDecimals !== null
    ? rows.map((row) => ({ timestamp: Number(row.timestamp), price: poolPriceInQuote(
      BigInt(row.sqrt_price_x96), displayedDecimals, quoteDecimals, displayedIsCurrency0),
    })).filter((row): row is { timestamp: number; price: string } => row.price !== null) : [];
  return {
    volume24hUsd, priceInQuote: complete ? priceInQuote : null, priceUsd: complete ? priceUsd : null,
    fdvUsd: complete ? fdvUsd : null, tvlUsd: complete ? tvlUsd : null,
    change1h: complete ? computePriceChange(pricePoints, asOf, 3600) : null,
    change1d: complete ? computePriceChange(pricePoints, asOf, 86400) : null,
    coverageStatus: catalog.coverage_status, lastTradeTimestamp: last ? Number(last.timestamp) : null,
  };
}
