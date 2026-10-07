'use client';

import { useSimulateContract } from 'wagmi';
import { v4QuoterAbi, V4_QUOTER_ADDRESS } from './v4QuoterAbi';
import { decodeTradeError } from './decodeTradeError';
import type { V4PoolKey } from './v4SwapEncoding';

export interface V4SwapQuoteParams {
  poolKey: V4PoolKey | undefined;
  zeroForOne: boolean;
  amountIn: bigint;
}

export interface V4SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export function useV4SwapQuote({ poolKey, zeroForOne, amountIn }: V4SwapQuoteParams): V4SwapQuoteResult {
  const enabled = Boolean(poolKey && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: V4_QUOTER_ADDRESS,
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingleV4',
    args: enabled ? [{ poolKey: poolKey as V4PoolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }] : undefined,
    query: { enabled },
  });

  return {
    // data.result is [amountOut, gasEstimate] — only amountOut is ever shown to a user or used
    // to compute amountOutMinimum; the gas estimate has no use in this app.
    outputAmount: data?.result?.[0] ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
