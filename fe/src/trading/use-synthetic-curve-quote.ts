'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { robinhoodChain } from '@/wallet/config';
import { makeCurveForwardQuote } from './reverse-quote';
import type { CurveQuoteResult } from './use-curve-quote';
import { decodeTradeError } from './decodeTradeError';

export interface SyntheticCurveQuoteParams {
  curveAddress: Address | undefined;
  direction: 'buy' | 'sell';
  amountIn: bigint;
  tokenAddress: Address;
  quoteAssetAddress: Address;
  isNativeQuote: boolean;
  enabled: boolean;
}

/**
 * Curve quote for a visitor with no wallet: wagmi's useSimulateContract stays disabled until a connector is connected and the curve's
 * buy()/sell() need a sender with funds, so the call is simulated on the public client as a synthetic account that is given the balance
 * and allowance by state override (the same trick the reverse quote uses). With a wallet connected the panel keeps the wallet's own simulation.
 */
export function useSyntheticCurveQuote(params: SyntheticCurveQuoteParams): CurveQuoteResult {
  const { curveAddress, direction, amountIn, tokenAddress, quoteAssetAddress, isNativeQuote, enabled } = params;
  const client = usePublicClient({ chainId: robinhoodChain.id });
  const active = enabled && Boolean(curveAddress && client) && amountIn > 0n;
  const query = useQuery({
    queryKey: ['curve-quote-synthetic', curveAddress?.toLowerCase(), direction, amountIn.toString(), isNativeQuote, quoteAssetAddress.toLowerCase()],
    enabled: active,
    retry: 1,
    queryFn: async () => {
      const quote = makeCurveForwardQuote(client as never, { curveAddress: curveAddress!, direction, tokenAddress, quoteAssetAddress, isNativeQuote });
      return { result: await quote(amountIn) };
    },
  });
  return {
    outputAmount: query.data?.result ?? null,
    isLoading: query.isLoading,
    errorMessage: query.error ? decodeTradeError(query.error) : null,
    refetch: () => { if (active) void query.refetch(); },
  };
}
