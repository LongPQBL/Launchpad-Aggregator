'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { v3QuoterAbi, V3_QUOTER_ADDRESS } from './v3QuoterAbi';
import { decodeTradeError } from './decodeTradeError';

export interface V3SwapQuoteParams {
  tokenIn: Address | undefined;
  tokenOut: Address | undefined;
  fee: number | null;
  amountIn: bigint;
}

export interface V3SwapQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
}

// Unlike the old use-swap-quote.ts this replaces, this quote is fully decoupled from the
// connected account's approval state — V3_QUOTER_ADDRESS needs no allowance at all (see the
// spec's "The blocker this spec resolves" section), so there is no recipient/account parameter
// and no need for use-refetch-quote-after-approval.ts's pre-approval-revert workaround.
export function useV3SwapQuote({ tokenIn, tokenOut, fee, amountIn }: V3SwapQuoteParams): V3SwapQuoteResult {
  const enabled = Boolean(tokenIn && tokenOut && fee !== null && amountIn > 0n);
  const { data, isLoading, error } = useSimulateContract({
    address: V3_QUOTER_ADDRESS,
    abi: v3QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: enabled ? [{
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn,
      fee: fee as number,
      sqrtPriceLimitX96: 0n,
    }] : undefined,
    query: { enabled },
  });

  return {
    // data.result is [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] —
    // only amountOut is ever shown to a user or used to compute amountOutMinimum.
    outputAmount: data?.result?.[0] ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
