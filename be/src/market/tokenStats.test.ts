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
  it('returns null when the token price in quote-asset terms is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, null, 2691.70)).toBeNull();
  });

  it('returns null when the quote-asset USD price is unavailable', () => {
    expect(computeFdvUsd(1_000_000_000_000_000_000_000n, 18, '0.0001', null)).toBeNull();
  });

  it('multiplies total supply (in token units) by price-in-quote-asset by quote-asset USD price', () => {
    // 1000 tokens (18 decimals) * 0.0001 ETH/token * $2691.70/ETH = $269.17
    const result = computeFdvUsd(1_000n * 10n ** 18n, 18, '0.0001', 2691.70);
    expect(Number(result)).toBeCloseTo(269.17, 2);
  });
});
