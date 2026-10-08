'use client';

import { useState } from 'react';
import { formatUnits } from 'viem';
import { parseAmountSafe } from './amount';
import type { ReverseSolve } from './reverse-quote';
import { useReverseQuote, type ReverseStatus } from './use-reverse-quote';

export type AmountSource = 'sell' | 'buy';

export interface UseSwapAmountsParams {
  tokenInDecimals: number;
  tokenOutDecimals: number;
  solve: ReverseSolve | null;
  solveKey: string;
}

export interface SwapAmounts {
  source: AmountSource;
  typed: string;
  // The exact-input amount every venue executes with: parsed from the Sell box when the user typed
  // there, otherwise derived from the Buy box via the reverse quote (0n until derived/unavailable).
  amountIn: bigint;
  reverseStatus: ReverseStatus;
  sellText: string;
  buyTypedText: string;
  onSellChange: (value: string) => void;
  onBuyChange: (value: string) => void;
  flip: () => void;
  reset: () => void;
}

export function useSwapAmounts({ tokenInDecimals, tokenOutDecimals, solve, solveKey }: UseSwapAmountsParams): SwapAmounts {
  const [source, setSource] = useState<AmountSource>('sell');
  const [typed, setTyped] = useState('');

  const targetOut = source === 'buy' ? parseAmountSafe(typed, tokenOutDecimals) : 0n;
  const reverse = useReverseQuote({ targetOut, solve, solveKey });

  const amountIn = source === 'sell' ? parseAmountSafe(typed, tokenInDecimals) : (reverse.amountIn ?? 0n);
  const sellText = source === 'sell' ? typed : (reverse.amountIn !== null ? formatUnits(reverse.amountIn, tokenInDecimals) : '');

  return {
    source,
    typed,
    amountIn,
    reverseStatus: source === 'buy' ? reverse.status : 'idle',
    sellText,
    buyTypedText: source === 'buy' ? typed : '',
    onSellChange: (value) => { setSource('sell'); setTyped(value); },
    onBuyChange: (value) => { setSource('buy'); setTyped(value); },
    // The typed number belongs to a token, not to a card — flipping moves that token to the other
    // card, so the source moves with it and the typed text is kept.
    flip: () => setSource((current) => (current === 'sell' ? 'buy' : 'sell')),
    reset: () => setTyped(''),
  };
}
