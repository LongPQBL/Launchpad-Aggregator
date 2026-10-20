'use client';

import type { Address } from 'viem';
import { useReadContract } from 'wagmi';
import { v2PairAbi } from './v2PairAbi';
import { v2AmountOut } from './v2-math';

export interface V2SwapQuoteParams {
  pair: Address | undefined;
  tokenIn: Address | undefined;
  tokenOut: Address | undefined;
  amountIn: bigint;
}

export interface V2SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

// A V2 pair has no quoter: its two reserves are the price, so the quote is the library formula applied to them. Reads need no wallet.
export function useV2SwapQuote({ pair, tokenIn, tokenOut, amountIn }: V2SwapQuoteParams): V2SwapQuoteResult {
  const enabled = Boolean(pair && tokenIn && tokenOut);
  const reserves = useReadContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves',
    query: { enabled, refetchInterval: 15_000 } });
  const token0 = useReadContract({ address: pair, abi: v2PairAbi, functionName: 'token0', query: { enabled, staleTime: Infinity } });

  const ready = reserves.data !== undefined && token0.data !== undefined && tokenIn !== undefined;
  let outputAmount: bigint | null = null;
  if (ready && amountIn > 0n) {
    const inIsToken0 = token0.data!.toLowerCase() === tokenIn!.toLowerCase();
    const [reserve0, reserve1] = reserves.data!;
    outputAmount = v2AmountOut(amountIn, inIsToken0 ? reserve0 : reserve1, inIsToken0 ? reserve1 : reserve0);
  }
  const failed = Boolean(reserves.error || token0.error);
  return {
    outputAmount,
    isLoading: enabled && !ready && !failed,
    errorMessage: amountIn <= 0n ? null
      : failed ? 'Pool reserves unavailable'
        : ready && outputAmount === null ? 'Not enough liquidity in the pool' : null,
  };
}
