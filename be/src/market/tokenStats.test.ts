import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { computeFdvUsd, readTotalSupply } from './tokenStats.js';
import type { UsdPriceClient } from './usdPricing.js';

describe('readTotalSupply', () => {
  it('returns null instead of throwing when the token is not a standard ERC-20', async () => {
    const client: UsdPriceClient = { readContract: vi.fn().mockRejectedValue(new Error('execution reverted')) };
    const result = await readTotalSupply(client, '0x1111111111111111111111111111111111111111' as Address);
    expect(result).toBeNull();
  });

  it('reads totalSupply() for a standard token', async () => {
    const client: UsdPriceClient = { readContract: vi.fn().mockResolvedValue(1_000_000_000_000_000_000_000n) };
    const result = await readTotalSupply(client, '0x1111111111111111111111111111111111111111' as Address);
    expect(result).toBe(1_000_000_000_000_000_000_000n);
  });
});

describe('computeFdvUsd', () => {
  it('returns null when the price numerator is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, null, 10n, 2691.70)).toBeNull();
  });

  it('returns null when the quote-asset USD price is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, 1n, 10_000n, null)).toBeNull();
  });

  it('multiplies total supply (in token units) by price-in-quote-asset by quote-asset USD price', () => {
    // 1000 tokens (18 decimals) * 0.0001 ETH/token * $2691.70/ETH = $269.17
    const result = computeFdvUsd(1_000n * 10n ** 18n, 18, 1n, 10_000n, 2691.70);
    expect(Number(result)).toBeCloseTo(269.17, 2);
  });

  it('does not underflow to zero for a price far smaller than 18 decimal places (fixed-decimal formatting would round it away)', () => {
    // A freshly launched curve's very first trade: price = 9e18 / 1e45 = 9e-27 quote per token.
    // 1e9 tokens (18 decimals) * 9e-27 ETH/token * $2700/ETH = 2.43e-14, tiny but not zero.
    const result = computeFdvUsd(1_000_000_000n * 10n ** 18n, 18, 9_000_000_000_000_000_000n,
      1_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000n, 2700);
    expect(result).not.toBeNull();
    expect(Number(result)).toBeGreaterThan(0);
    expect(Number(result)).toBeCloseTo(2.43e-14, 16);
  });
});
