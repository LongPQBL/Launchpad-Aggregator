import { describe, expect, it } from 'vitest';
import { v2AmountIn, v2AmountOut } from './v2-math';

describe('Uniswap V2 swap math', () => {
  it('matches the library formula for a known pool', () => {
    // 1,000,000 in against reserves 10,000,000 / 5,000,000: 997,000,000 * 5,000,000 / (10,000,000,000 + 997,000,000)
    expect(v2AmountOut(1_000_000n, 10_000_000n, 5_000_000n)).toBe(453_305n);
  });

  it('has no answer for a zero amount, an empty pool, or an output that rounds to zero', () => {
    expect(v2AmountOut(0n, 10n, 10n)).toBeNull();
    expect(v2AmountOut(5n, 0n, 10n)).toBeNull();
    expect(v2AmountOut(5n, 10n, 0n)).toBeNull();
    expect(v2AmountOut(1n, 10n ** 12n, 10n)).toBeNull();
  });

  it('inverts: the input for an output buys at least that output, and one unit less buys less', () => {
    const reserveIn = 10_000_000n;
    const reserveOut = 5_000_000n;
    const target = 450_000n;
    const needed = v2AmountIn(target, reserveIn, reserveOut)!;
    expect(v2AmountOut(needed, reserveIn, reserveOut)!).toBeGreaterThanOrEqual(target);
    expect(v2AmountOut(needed - 1n, reserveIn, reserveOut)!).toBeLessThan(target);
  });

  it('cannot buy the whole reserve or more', () => {
    expect(v2AmountIn(5_000_000n, 10_000_000n, 5_000_000n)).toBeNull();
    expect(v2AmountIn(6_000_000n, 10_000_000n, 5_000_000n)).toBeNull();
  });
});
