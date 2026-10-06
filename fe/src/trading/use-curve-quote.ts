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
  const { data, isLoading, error } = direction === 'buy'
    ? useSimulateContract({
        address: curveAddress,
        abi: curveTradeAbi,
        functionName: 'buy',
        args: recipient ? [amountIn, 0n, recipient] : undefined,
        value: nativeValue,
        query: { enabled },
      })
    : useSimulateContract({
        address: curveAddress,
        abi: curveTradeAbi,
        functionName: 'sell',
        args: recipient ? [amountIn, 0n, recipient] : undefined,
        query: { enabled },
      });

  return {
    outputAmount: data?.result ?? null,
    isLoading,
    errorMessage: error ? decodeTradeError(error) : null,
  };
}
