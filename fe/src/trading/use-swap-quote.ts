'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { swapRouterAbi, SWAP_ROUTER_ADDRESS } from './swapRouterAbi';
import { decodeTradeError } from './decodeTradeError';

export interface SwapQuoteParams {
  tokenIn: Address | undefined;
  tokenOut: Address | undefined;
  fee: number | null;
  amountIn: bigint;
  recipient: Address | undefined;
}

export interface SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export function useSwapQuote({ tokenIn, tokenOut, fee, amountIn, recipient }: SwapQuoteParams): SwapQuoteResult {
  const enabled = Boolean(tokenIn && tokenOut && fee !== null && recipient && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: SWAP_ROUTER_ADDRESS,
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: enabled ? [{
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      fee: fee as number,
      recipient: recipient as Address,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }] : undefined,
    query: { enabled },
  });

  return {
    outputAmount: data?.result ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
