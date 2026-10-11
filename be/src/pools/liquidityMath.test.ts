import { describe, expect, it } from 'vitest';
import { buildDepth, buildRanges, netLiquidityTotal, sqrtToPrice, tickToPrice, tickToSqrt } from './liquidityMath.js';

describe('tick prices', () => {
  it('is 1 at tick 0 with equal decimals and adjusts for differing decimals', () => {
    expect(tickToPrice(0, 18, 18)).toBe(1);
    expect(tickToPrice(0, 18, 6)).toBe(1e12);
    expect(tickToPrice(10_000, 18, 18)).toBeCloseTo(1.0001 ** 10_000, 6);
    expect(sqrtToPrice(tickToSqrt(1234), 18, 18)).toBeCloseTo(1.0001 ** 1234, 9);
  });
});

describe('buildRanges', () => {
  it('turns net liquidity at ticks into ranges and marks the active one', () => {
    const ticks = [{ tick: -100, liquidityNet: 10n }, { tick: 100, liquidityNet: 5n }, { tick: 300, liquidityNet: -15n }];
    expect(buildRanges(ticks, 0)).toEqual([
      { tickLower: -100, tickUpper: 100, liquidity: 10n, active: true },
      { tickLower: 100, tickUpper: 300, liquidity: 15n, active: false },
    ]);
    expect(netLiquidityTotal(ticks)).toBe(0n);
  });
  it('is empty for no ticks, sorts unsorted input, and skips ranges without liquidity', () => {
    expect(buildRanges([], 0)).toEqual([]);
    const gap = [{ tick: 200, liquidityNet: -4n }, { tick: -50, liquidityNet: 4n }, { tick: 0, liquidityNet: -4n }, { tick: 100, liquidityNet: 4n }];
    expect(buildRanges(gap, 150).map((r) => [r.tickLower, r.tickUpper, r.active])).toEqual([[-50, 0, false], [100, 200, true]]);
  });
});

describe('buildDepth', () => {
  // One range [-60000, 60000) with L = 1e18 around the current tick 0 (price 1, 18/18 decimals), spacing 60.
  const input = { ranges: [{ tickLower: -60_000, tickUpper: 60_000, liquidity: 10n ** 18n, active: true }], currentTick: 0, sqrtPriceX96: 2n ** 96n,
    tickSpacing: 60, decimals0: 18, decimals1: 18, feePips: 500, maxRows: 5 };
  it('reproduces the constant-liquidity amounts for the first ask row', () => {
    const depth = buildDepth(input);
    const sqrtB = tickToSqrt(60);
    expect(depth.asks[0]!.amount0).toBeCloseTo((1 - 1 / sqrtB) , 9);
    expect(depth.asks[0]!.total1).toBeCloseTo(sqrtB - 1, 9);
    expect(depth.asks[0]!.price).toBeCloseTo(1.0001 ** 60, 9);
  });
  it('accumulates token1 away from the current price on both sides and orders rows nearest first', () => {
    const depth = buildDepth(input);
    expect(depth.asks).toHaveLength(5);
    expect(depth.bids).toHaveLength(5);
    expect(depth.asks[1]!.cumulative1).toBeCloseTo(depth.asks[0]!.total1 + depth.asks[1]!.total1, 12);
    expect(depth.asks.every((row, i) => i === 0 || row.price > depth.asks[i - 1]!.price)).toBe(true);
    expect(depth.bids.every((row, i) => i === 0 || row.price < depth.bids[i - 1]!.price)).toBe(true);
  });
  it('shows nothing where there is no liquidity, and a spread of twice the fee tier', () => {
    const depth = buildDepth({ ...input, ranges: [{ tickLower: -600, tickUpper: -300, liquidity: 10n ** 18n, active: false }] });
    expect(depth.asks.every((row) => row.total1 === 0)).toBe(true);
    expect(depth.bids.some((row) => row.total1 > 0)).toBe(false);
    expect(depth.spreadPercent).toBeCloseTo(0.1, 12);
  });
  it('scales amounts by each token\'s decimals', () => {
    const six = buildDepth({ ...input, decimals0: 18, decimals1: 6, maxRows: 1 });
    const same = buildDepth({ ...input, maxRows: 1 });
    expect(six.asks[0]!.total1).toBeCloseTo(same.asks[0]!.total1 * 1e12, 0);
  });
});
