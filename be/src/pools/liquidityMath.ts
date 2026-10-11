export interface LiquidityRange { tickLower: number; tickUpper: number; liquidity: bigint; active: boolean }
export interface DepthRow { price: number; amount0: number; total1: number; cumulative1: number }
export interface DepthResult { asks: DepthRow[]; bids: DepthRow[]; spreadPercent: number | null }

const Q96 = 2 ** 96;
const MAX_ROW_TICKS = 100;

/** sqrt(1.0001^tick) as a float. */
export function tickToSqrt(tick: number): number { return 1.0001 ** (tick / 2); }

/** Price of token0 in token1 at a tick, adjusted for the two tokens' decimals. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/** Price of token0 in token1 for a raw sqrt price (Q64.96). */
export function sqrtToPrice(sqrt: number, decimals0: number, decimals1: number): number {
  return sqrt * sqrt * 10 ** (decimals0 - decimals1);
}

/**
 * Turns the initialized ticks' net liquidity into the ranges that hold liquidity: between two neighbouring initialized ticks the liquidity is the running
 * sum of `liquidityNet` up to the lower one. Ranges with no liquidity are left out. `active` marks the range containing the current tick.
 */
export function buildRanges(ticks: readonly { tick: number; liquidityNet: bigint }[], currentTick: number): LiquidityRange[] {
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  const ranges: LiquidityRange[] = [];
  let running = 0n;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    running += sorted[index]!.liquidityNet;
    const tickLower = sorted[index]!.tick;
    const tickUpper = sorted[index + 1]!.tick;
    if (running > 0n) ranges.push({ tickLower, tickUpper, liquidity: running, active: tickLower <= currentTick && currentTick < tickUpper });
  }
  return ranges;
}

/** What is left in the pool after the last initialized tick: 0 for a consistent tick set. */
export function netLiquidityTotal(ticks: readonly { liquidityNet: bigint }[]): bigint {
  return ticks.reduce((sum, entry) => sum + entry.liquidityNet, 0n);
}

/** Amounts of token0 and token1 (raw units, as floats) that a constant liquidity `liquidity` spans between two sqrt prices (sqrtLow < sqrtHigh). */
function amountsBetween(liquidity: number, sqrtLow: number, sqrtHigh: number): { amount0: number; amount1: number } {
  return { amount0: liquidity * (1 / sqrtLow - 1 / sqrtHigh), amount1: liquidity * (sqrtHigh - sqrtLow) };
}

function windowAmounts(ranges: readonly LiquidityRange[], sqrtLow: number, sqrtHigh: number): { amount0: number; amount1: number } {
  let amount0 = 0;
  let amount1 = 0;
  for (const range of ranges) {
    const low = Math.max(sqrtLow, tickToSqrt(range.tickLower));
    const high = Math.min(sqrtHigh, tickToSqrt(range.tickUpper));
    if (high <= low) continue;
    const part = amountsBetween(Number(range.liquidity), low, high);
    amount0 += part.amount0;
    amount1 += part.amount1;
  }
  return { amount0, amount1 };
}

/**
 * Order-book view of a pool's liquidity: rows one tick spacing wide going up from the current price (asks: token0 you can buy, and what it costs in token1)
 * and down (bids: token0 you can sell into, and what you receive), nearest row first, with the running token1 total. The spread is twice the fee tier, as Uniswap shows it.
 */
export function buildDepth(input: {
  ranges: readonly LiquidityRange[]; currentTick: number; sqrtPriceX96: bigint; tickSpacing: number;
  decimals0: number; decimals1: number; feePips: number; maxRows?: number;
}): DepthResult {
  const maxRows = input.maxRows ?? 40;
  // Rows are one tick spacing wide, but never wider than ~1% of price: liquidity is constant inside a range, so a coarse spacing does not need coarse rows.
  const spacing = Math.max(1, Math.min(input.tickSpacing, MAX_ROW_TICKS));
  const currentSqrt = Number(input.sqrtPriceX96) / Q96;
  const scale0 = 10 ** input.decimals0;
  const scale1 = 10 ** input.decimals1;
  const side = (direction: 1 | -1): DepthRow[] => {
    const rows: DepthRow[] = [];
    let edge = currentSqrt;
    let cumulative1 = 0;
    const firstBoundary = direction === 1 ? (Math.floor(input.currentTick / spacing) + 1) * spacing : Math.floor(input.currentTick / spacing) * spacing;
    // A boundary equal to the current price gives a zero-width first step: skipped, and not counted as a row.
    for (let step = 0; step <= maxRows && rows.length < maxRows; step += 1) {
      const next = tickToSqrt(firstBoundary + direction * step * spacing);
      const sqrtLow = Math.min(edge, next);
      const sqrtHigh = Math.max(edge, next);
      edge = next;
      if (sqrtHigh - sqrtLow <= 0) continue;
      const { amount0, amount1 } = windowAmounts(input.ranges, sqrtLow, sqrtHigh);
      cumulative1 += amount1 / scale1;
      rows.push({ price: sqrtToPrice(next, input.decimals0, input.decimals1), amount0: amount0 / scale0, total1: amount1 / scale1, cumulative1 });
    }
    // Rows beyond the last range with liquidity carry nothing; they are dropped instead of padding the table.
    while (rows.length > 0 && rows[rows.length - 1]!.total1 === 0) rows.pop();
    return rows;
  };
  return { asks: side(1), bids: side(-1), spreadPercent: (2 * input.feePips) / 10_000 };
}
