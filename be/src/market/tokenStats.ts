import type { Address } from 'viem';
import { parseAbi, formatUnits } from 'viem';
import type { UsdPriceClient } from './usdPricing.js';

const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)']);

export async function readTotalSupply(client: UsdPriceClient, tokenAddress: Address): Promise<bigint | null> {
  try {
    const result = await client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'totalSupply' });
    return typeof result === 'bigint' ? result : null;
  } catch {
    return null;
  }
}

// TVL/Liquidity is null for every venue kind (curve, v3_pool, v4_pool), not computed at all in
// this plan. A real check against the live graduated V4 pool in
// tests/fixtures/pons-v2-graduated.json showed why a naive `liquidity() * price` read is wrong,
// not just imprecise: Uniswap V3/V4 `liquidity` (L) is a concentrated-liquidity math parameter,
// not a token amount — that naive formula produced $2.48e+26 (wrong by ~20+ orders of magnitude).
// Correct conversion needs sqrtPriceX96-based reserve math and, for true TVL, summing liquidity
// across every initialized tick (not just the current one). V4 additionally has shared custody
// (PoolManager holds every pool's funds together), so there is no per-pool balanceOf fallback
// either. See the plan's Task 3 ledger ruling — this is a documented, deliberate gap, matching how
// curve-phase TVL was already scoped out in spec docs/superpowers/specs/2026-10-01-uniswap-parity-stats-design.md §4.
export async function readTvlUsd(client: UsdPriceClient, venue: { kind: string; ref: string }, quoteAssetUsdPrice: number | null): Promise<string | null> {
  void client; void venue; void quoteAssetUsdPrice;
  return null;
}

export function computeFdvUsd(totalSupply: bigint, tokenDecimals: number, priceInQuoteAsset: string | null, quoteAssetUsdPrice: number | null): string | null {
  if (priceInQuoteAsset === null || quoteAssetUsdPrice === null) return null;
  const supplyInTokenUnits = Number(formatUnits(totalSupply, tokenDecimals));
  const fdvUsd = supplyInTokenUnits * Number(priceInQuoteAsset) * quoteAssetUsdPrice;
  return fdvUsd.toString();
}
