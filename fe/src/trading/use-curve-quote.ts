'use client';

import type { Address } from 'viem';
import { useSimulateContract } from 'wagmi';
import { curveTradeAbi } from './curveAbi';
import { decodeTradeError } from './decodeTradeError';

export interface CurveQuoteParams {
  curveAddress: Address | undefined;
  direction: 'buy' | 'sell';
  amountIn: bigint;
  recipient: Address | undefined;
  // Only read for direction: 'buy' on a native-ETH-quoted launch — undefined/0 for an
  // ERC20-quoted launch, where the curve pulls funds via transferFrom instead (see curveAbi.ts).
  nativeValue: bigint | undefined;
}

export interface CurveQuoteResult {
  outputAmount: bigint | null;
  isLoading: boolean;
  errorMessage: string | null;
  // Exposed so a caller can re-run the quote once an approval confirms — useSimulateContract
  // caches a pre-approval revert (e.g. the curve's transferFrom on an ERC20-quoted buy/sell)
  // under the same query key, since none of curveAddress/direction/amountIn/recipient change
  // across the approval, and its own retry budget is already exhausted by the time a real user
  // finishes approving. See use-swap-quote.ts's identical fix for the same bug shape.
  refetch: () => void;
}

export function useCurveQuote({ curveAddress, direction, amountIn, recipient, nativeValue }: CurveQuoteParams): CurveQuoteResult {
  const enabled = Boolean(curveAddress && recipient && amountIn > 0n);
  const args = recipient ? ([amountIn, 0n, recipient] as const) : undefined;

  const buyResult = useSimulateContract({
    address: curveAddress,
    abi: curveTradeAbi,
    functionName: 'buy',
    args,
    value: nativeValue,
    query: { enabled: enabled && direction === 'buy' },
  });
  const sellResult = useSimulateContract({
    address: curveAddress,
    abi: curveTradeAbi,
    functionName: 'sell',
    args,
    query: { enabled: enabled && direction === 'sell' },
  });

  const { data, isLoading, error, refetch } = direction === 'buy' ? buyResult : sellResult;

  return {
    outputAmount: data?.result ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
    refetch: () => { void refetch(); },
  };
}
