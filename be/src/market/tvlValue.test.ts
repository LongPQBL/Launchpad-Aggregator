import { describe, expect, it } from 'vitest';
import { calculateTvlUsd } from './tvlValue.js';

describe('calculateTvlUsd', () => {
  it('values a six-decimal curve quote without counting launch tokens', () => {
    expect(calculateTvlUsd({ tokenRaw: 0n, quoteRaw: 15_700_717n, blockNumber: 1n,
      basis: 'curve_real_quote', sqrtPriceX96: null, tokenIsCurrency0: null }, 6, 18, 0.99992674))
      .toBe('15.69956676');
  });

  it('values both real pool sides at the pool price and quote oracle price', () => {
    expect(calculateTvlUsd({ tokenRaw: 100n, quoteRaw: 200n, blockNumber: 1n,
      basis: 'pool_principal', sqrtPriceX96: 2n ** 96n, tokenIsCurrency0: true }, 0, 0, 2))
      .toBe('600');
  });

  it('preserves large raw token amounts that exceed Number precision', () => {
    expect(calculateTvlUsd({ tokenRaw: 10n ** 30n, quoteRaw: 0n, blockNumber: 1n,
      basis: 'pool_custody', sqrtPriceX96: 2n ** 96n, tokenIsCurrency0: false }, 18, 18, 1))
      .toBe('1000000000000');
  });

  it('accepts small oracle prices written in exponent notation', () => {
    expect(calculateTvlUsd({ tokenRaw: 0n, quoteRaw: 100_000_000n, blockNumber: 1n,
      basis: 'curve_real_quote', sqrtPriceX96: null, tokenIsCurrency0: null }, 0, 18, 1e-8))
      .toBe('1');
  });
});
