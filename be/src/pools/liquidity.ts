import type { Pool } from 'pg';
import { buildDepth, buildRanges, netLiquidityTotal, sqrtToPrice, tickToPrice, type DepthResult } from './liquidityMath.js';
import { readPoolLiquidity, type LiquidityClient } from './liquidityRead.js';
import { readLensSnapshot } from './lens.js';
import { assetDecimals, type PoolKey } from './stats.js';

export interface PoolLiquidityRange { tickLower: number; tickUpper: number; priceLower: number; priceUpper: number; liquidity: string; active: boolean }
export interface PoolLiquidityAnswer {
  protocol: 'uniswap_v3' | 'uniswap_v4';
  blockNumber: string | null; tickSpacing: number; feePips: number; currentTick: number | null;
  /** token1 per token0 at the current price, and the inverse; null when unavailable. */
  price: number | null; priceInverse: number | null; activeLiquidity: string | null;
  token0: { address: string; decimals: number | null }; token1: { address: string; decimals: number | null };
  ranges: PoolLiquidityRange[]; depth: DepthResult | null;
  /** True when the answer is a full, cross-checked read (an empty pool is a real, complete answer). */
  complete: boolean;
  /** Why there is no usable answer: could not read, tick set too large, accounting not standard, or the ticks do not add up to the pool's liquidity. */
  unavailableReason: 'read_failed' | 'too_many_ticks' | 'decimals_unavailable' | 'accounting_unverified' | 'liquidity_mismatch' | null;
}

interface CatalogRow { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }

/**
 * The pool's liquidity per price range and an order-book depth view, read from the chain at one block. Null for an unknown pool or a V2 pair (no ticks).
 * Never a partial answer: any read problem, or ticks that do not add up to the pool's reported liquidity, gives `unavailableReason` and no ranges.
 */
export async function readPoolLiquidityAnswer(pool: Pool, client: LiquidityClient, key: PoolKey, maxRows = 40): Promise<PoolLiquidityAnswer | null> {
  if (key.protocol === 'uniswap_v2') return null;
  const found = await pool.query(`SELECT currency0, currency1, fee, tick_spacing, hooks FROM pool_catalog
    WHERE chain_id=$1 AND protocol=$2 AND pool_id=$3 AND verified=true`, [key.chainId, key.protocol, key.poolId.toLowerCase()]);
  const row = found.rows[0] as CatalogRow | undefined;
  if (!row) return null;
  const [decimals0, decimals1] = await Promise.all([assetDecimals(client, row.currency0), assetDecimals(client, row.currency1)]);
  const base = {
    protocol: key.protocol, blockNumber: null, tickSpacing: row.tick_spacing, feePips: row.fee, currentTick: null, price: null, priceInverse: null, activeLiquidity: null,
    token0: { address: row.currency0, decimals: decimals0 }, token1: { address: row.currency1, decimals: decimals1 }, ranges: [], depth: null, complete: false,
  };
  if (decimals0 === null || decimals1 === null) return { ...base, unavailableReason: 'decimals_unavailable' };
  // A V4 hook with custom accounting does not follow tick liquidity; the reserves lens only answers for standard accounting.
  if (key.protocol === 'uniswap_v4' && !(await readLensSnapshot(client, { currency0: row.currency0, currency1: row.currency1, fee: row.fee, tick_spacing: row.tick_spacing, hooks: row.hooks }))) {
    return { ...base, unavailableReason: 'accounting_unverified' };
  }
  const read = await readPoolLiquidity(client, { protocol: key.protocol, poolId: key.poolId.toLowerCase(), tickSpacing: row.tick_spacing });
  if (!read.ok) return { ...base, unavailableReason: read.reason };
  const ranges = buildRanges(read.ticks, read.tick);
  const active = ranges.find((range) => range.active)?.liquidity ?? 0n;
  if (netLiquidityTotal(read.ticks) !== 0n || active !== read.liquidity) return { ...base, blockNumber: read.blockNumber.toString(), unavailableReason: 'liquidity_mismatch' };
  const price = sqrtToPrice(Number(read.sqrtPriceX96) / 2 ** 96, decimals0, decimals1);
  return {
    ...base, blockNumber: read.blockNumber.toString(), currentTick: read.tick, price, priceInverse: price > 0 ? 1 / price : null, activeLiquidity: read.liquidity.toString(),
    ranges: ranges.map((range) => ({ tickLower: range.tickLower, tickUpper: range.tickUpper, liquidity: range.liquidity.toString(), active: range.active,
      priceLower: tickToPrice(range.tickLower, decimals0, decimals1), priceUpper: tickToPrice(range.tickUpper, decimals0, decimals1) })),
    depth: buildDepth({ ranges, currentTick: read.tick, sqrtPriceX96: read.sqrtPriceX96, tickSpacing: row.tick_spacing, decimals0, decimals1, feePips: row.fee, maxRows }),
    complete: true, unavailableReason: null,
  };
}
