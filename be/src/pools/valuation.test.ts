import { describe, expect, it } from 'vitest';
import { poolPriceInQuote, sumUsdValues } from './valuation.js';

const q96 = 2n ** 96n;
describe('poolPriceInQuote', () => {
  it('calculates either displayed side from the same verified sqrt price', () => {
    expect(poolPriceInQuote(q96, 18, 18, true)).toBe('1');
    expect(poolPriceInQuote(2n * q96, 18, 18, true)).toBe('4');
    expect(poolPriceInQuote(2n * q96, 18, 18, false)).toBe('0.25');
  });
  it('adjusts for token decimals and rejects unavailable inputs', () => {
    expect(poolPriceInQuote(q96, 18, 6, true)).toBe('1000000000000');
    expect(poolPriceInQuote(0n, 18, 6, true)).toBeNull();
    expect(poolPriceInQuote(q96, null, 6, true)).toBeNull();
  });
});

describe('sumUsdValues', () => {
  it('adds trade USD values without floating-point accumulation error', () => {
    expect(sumUsdValues(['0.1', '0.2', '1e-7'])).toBe('0.3000001');
  });
});
