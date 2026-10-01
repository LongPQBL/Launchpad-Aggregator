import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { computeFdvUsd, readTotalSupply, readTvlUsd } from './tokenStats.js';
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

// TVL/Liquidity is null for every venue kind, not just 'curve'. A real check against the live
// graduated V4 pool in tests/fixtures/pons-v2-graduated.json showed *why*: Uniswap V3/V4
// `liquidity` (L) is a concentrated-liquidity math parameter, not a token amount — naively
// multiplying it by a USD price produced $2.48e+26 (wrong by ~20+ orders of magnitude). Correct
// conversion needs sqrtPriceX96-based reserve math and, for true TVL, summing liquidity across
// every initialized tick (not just the current one) — out of scope for this plan. V4 additionally
// has shared custody (PoolManager holds every pool's funds together), so there is no per-pool
// balanceOf fallback either. See plan ledger Task 3 ruling.
describe('readTvlUsd', () => {
  it('returns null without an RPC call for a curve venue (not supported — see spec §4)', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readTvlUsd(client, { kind: 'curve', ref: '0xcurve' }, 2691.70);
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('returns null without an RPC call for a V3 pool venue (liquidity math not implemented — see Task 3 ruling)', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readTvlUsd(client, { kind: 'v3_pool', ref: '0xpool' }, 2691.70);
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('returns null without an RPC call for a V4 pool venue (liquidity math not implemented — see Task 3 ruling)', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readTvlUsd(client, { kind: 'v4_pool', ref: '0xpoolid' }, 2691.70);
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });
});
