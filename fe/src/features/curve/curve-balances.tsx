'use client';

import type { Address } from 'viem';
import { getCurveDepth } from '@/api/client';
import { LAUNCH_CHANGED_EVENT, TRADE_CREATED_EVENT } from '@/hooks/live-events';
import { useLoaded } from '@/hooks/use-loaded';
import { PoolBalances } from '@/features/pools/pool-balances';

// What a bonding curve really holds: its token balance and the quote asset paid into it. A curve may also carry a VIRTUAL quote reserve (it prices
// the curve but holds nothing), so the quote side here is the real reserve, never the virtual one; the price is the one the virtual reserves give.
export function CurveBalances({ chainId, curveAddress, token, quote }: {
  chainId: number; curveAddress: Address;
  token: { address: Address; symbol: string | null; decimals: number | null }; quote: { address: Address; symbol: string | null; decimals: number | null };
}) {
  const loaded = useLoaded(() => getCurveDepth(chainId, token.address), [chainId, token.address], {
    eventName: [TRADE_CREATED_EVENT, LAUNCH_CHANGED_EVENT],
    minIntervalMs: 4_000,
    matches: (payload) => payload.chainId === chainId && payload.tokenAddress?.toLowerCase() === token.address.toLowerCase(),
  });
  if (loaded.status === 'loading') return <p className="text-sm text-muted-foreground">Loading curve balances…</p>;
  const data = loaded.status === 'error' ? null : loaded.data;
  if (!data || !data.complete || data.tokenBalance == null || data.realQuoteReserve === null || data.price === null) {
    return <p className="text-sm text-muted-foreground">Curve balances unavailable</p>;
  }
  return <PoolBalances protocol="curve" poolAddress={curveAddress} displayed={token} other={quote} priceInQuote={String(data.price)}
    poolBalances={{ displayedAmountRaw: data.tokenBalance, otherAmountRaw: data.realQuoteReserve, priceInQuote: String(data.price) }} />;
}
