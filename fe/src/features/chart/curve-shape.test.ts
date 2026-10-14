import { describe, expect, it } from 'vitest';
import { buildCurveShape } from './curve-shape';

const e18 = 1e18;
const reserves = { quoteReserve: String(4 * e18), tokenReserve: String(1_000_000 * e18), realQuoteReserve: String(2 * e18),
  graduationThreshold: String(10 * e18), quoteDecimals: 18, tokenDecimals: 18 };

describe('buildCurveShape', () => {
  it('puts the current point at the reserves\' own spot price', () => {
    const shape = buildCurveShape(reserves)!;
    expect(shape.current.progress).toBeCloseTo(0.2);
    expect(shape.current.price).toBeCloseTo(4e-6, 12); // quoteReserve / tokenReserve
    expect(shape.current.quotePaidIn).toBeCloseTo(2);
  });
  it('rises along the curve from the start price to the graduation price', () => {
    const shape = buildCurveShape(reserves)!;
    expect(shape.points[0]!.price).toBeCloseTo(1e-6, 12); // (virtual 2)^2 / k
    expect(shape.graduation.price).toBeCloseTo(3.6e-5, 11); // (2 + 10)^2 / k
    expect(shape.points.every((point, index) => index === 0 || point.price > shape.points[index - 1]!.price)).toBe(true);
  });
  it('counts the tokens sold from the start of the curve', () => {
    const shape = buildCurveShape(reserves)!;
    expect(shape.points[0]!.tokensSold).toBeCloseTo(0);
    // k / virtual - k / reserve at the current point: 4e42/2e18 - 4e42/4e18 = 1e24 raw = 1,000,000 tokens
    expect(shape.current.tokensSold).toBeCloseTo(1_000_000, 0);
  });
  it('has no tokens-sold figure when the curve starts with no virtual reserve', () => {
    const shape = buildCurveShape({ ...reserves, quoteReserve: String(2 * e18) })!;
    expect(shape.points[0]!.tokensSold).toBeNull();
    expect(shape.points[0]!.price).toBe(0);
  });
  it('refuses reserves that cannot describe a curve', () => {
    expect(buildCurveShape({ ...reserves, tokenReserve: '0' })).toBeNull();
    expect(buildCurveShape({ ...reserves, realQuoteReserve: String(9 * e18) })).toBeNull(); // more paid in than the reserve holds
  });
});
