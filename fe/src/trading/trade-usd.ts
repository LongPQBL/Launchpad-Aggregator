import { formatUnits } from 'viem';
import { formatUsd } from '@/api/format';

// Lowercased token address -> USD price per whole token (decimal string), or null when unknown.
export type UsdPrices = Record<string, string | null>;

export function usdPriceFor(prices: UsdPrices | undefined, address: string): string | null {
  return prices?.[address.toLowerCase()] ?? null;
}

// USD value of a token amount, or null (line hidden) when there is no real price — null means
// unavailable, never "$0".
export function usdText(amount: bigint | null, decimals: number, priceUsd: string | null | undefined): string | null {
  if (amount === null || amount === 0n || priceUsd === null || priceUsd === undefined) return null;
  const value = Number(formatUnits(amount, decimals)) * Number(priceUsd);
  if (!Number.isFinite(value)) return null;
  return formatUsd(String(value), 2);
}
