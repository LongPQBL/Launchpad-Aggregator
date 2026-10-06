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

  const { data, isLoading, error } = direction === 'buy' ? buyResult : sellResult;

  return {
    outputAmount: data?.result ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
