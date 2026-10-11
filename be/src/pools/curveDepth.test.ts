import { describe, expect, it } from 'vitest';
import { buildCurveDepth } from './curveDepth.js';

const e18 = 10n ** 18n;
// 4 quote and 1,000,000 tokens of virtual reserves: price 0.000004 quote per token; 1% fee; graduates at 10 quote of real reserve (2 already in).
const state = { quoteReserve: 4n * e18, tokenReserve: 1_000_000n * e18, feeBps: 100n, realQuoteReserve: 2n * e18, graduationThreshold: 10n * e18 };
const decimals = { quote: 18, token: 18 };

describe('buildCurveDepth', () => {
  it('starts at the current price and moves 1% per row', () => {
    const depth = buildCurveDepth(state, decimals, 3);
    expect(depth.asks[0]!.price).toBeCloseTo(0.000004 * 1.01, 12);
    expect(depth.asks[1]!.price).toBeCloseTo(0.000004 * 1.01 ** 2, 12);
    expect(depth.bids[0]!.price).toBeCloseTo(0.000004 / 1.01, 12);
  });
  it('costs what the constant-product formula says for the first ask row, grossed up by the fee', () => {
    const depth = buildCurveDepth(state, decimals, 1);
    const q = 4; const t = 1_000_000; const k = q * t;
    const q1 = q * Math.sqrt(1.01);
    const net = q1 - q;
    expect(depth.asks[0]!.total1).toBeCloseTo(net / 0.99, 9);
    expect(depth.asks[0]!.amount0).toBeCloseTo(t - k / q1, 6);
  });
  it('pays out less than the gross on bids (the fee comes off the quote received)', () => {
    const depth = buildCurveDepth(state, decimals, 1);
    const q1 = 4 / Math.sqrt(1.01);
    expect(depth.bids[0]!.total1).toBeCloseTo((4 - q1) * 0.99, 9);
  });
  it('ends the asks at the graduation threshold and the bids at the real reserve', () => {
    const depth = buildCurveDepth(state, decimals, 400);
    expect(depth.asksEndAtGraduation).toBe(true);
    expect(depth.bidsEndAtEmptyReserve).toBe(true);
    // net quote that can still be added is 10 - 2 = 8; the last ask row's cumulative cost is that, grossed up by the fee
    expect(depth.asks.at(-1)!.cumulative1).toBeCloseTo(8 / 0.99, 6);
    // bids can pay out at most the 2 of real reserve, less the fee
    expect(depth.bids.at(-1)!.cumulative1).toBeCloseTo(2 * 0.99, 6);
  });
  it('has no asks once the curve is at the threshold and no bids with an empty real reserve; spread is twice the fee', () => {
    expect(buildCurveDepth({ ...state, realQuoteReserve: 10n * e18 }, decimals).asks).toEqual([]);
    expect(buildCurveDepth({ ...state, realQuoteReserve: 0n }, decimals).bids).toEqual([]);
    expect(buildCurveDepth(state, decimals).spreadPercent).toBeCloseTo(2, 12);
  });
  it('shows no rows for dust: a curve nobody has traded on has nothing to sell into', () => {
    const dust = buildCurveDepth({ ...state, realQuoteReserve: 17n }, decimals);
    expect(dust.bids).toEqual([]);
    expect(dust.asks.length).toBeGreaterThan(0);
  });
  it('adjusts prices for differing decimals', () => {
    const six = buildCurveDepth({ ...state, quoteReserve: 4_000_000n }, { quote: 6, token: 18 }, 1);
    expect(six.asks[0]!.price).toBeCloseTo(0.000004 * 1.01, 10);
  });
});
