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

export function computeFdvUsd(totalSupply: bigint, tokenDecimals: number, priceInQuoteAsset: string | null, quoteAssetUsdPrice: number | null): string | null {
  if (priceInQuoteAsset === null || quoteAssetUsdPrice === null) return null;
  const supplyInTokenUnits = Number(formatUnits(totalSupply, tokenDecimals));
  const fdvUsd = supplyInTokenUnits * Number(priceInQuoteAsset) * quoteAssetUsdPrice;
  return fdvUsd.toString();
}
