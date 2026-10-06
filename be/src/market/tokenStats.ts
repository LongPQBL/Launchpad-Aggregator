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

// Divides the raw numerator/denominator directly into a float rather than going through a
// fixed-18-decimal-place string (be/src/market/price.ts's formatRational): a price far below
// 1e-18 (a freshly launched curve's first trade routinely is) would otherwise round to the
// string "0" and silently zero out the whole FDV, even though Number(bigint) keeps the same
// ~15-17 significant digits regardless of how small the ratio is.
export function computeFdvUsd(totalSupply: bigint, tokenDecimals: number,
  priceNumeratorRaw: bigint | null, priceDenominatorRaw: bigint | null, quoteAssetUsdPrice: number | null): string | null {
  if (priceNumeratorRaw === null || priceDenominatorRaw === null || quoteAssetUsdPrice === null) return null;
  const supplyInTokenUnits = Number(formatUnits(totalSupply, tokenDecimals));
  const priceInQuoteAsset = Number(priceNumeratorRaw) / Number(priceDenominatorRaw);
  const fdvUsd = supplyInTokenUnits * priceInQuoteAsset * quoteAssetUsdPrice;
  return fdvUsd.toString();
}
