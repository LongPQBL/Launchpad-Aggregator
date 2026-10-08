'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReverseSolve } from './reverse-quote';

export const REVERSE_QUOTE_DEBOUNCE_MS = 300;

export type ReverseStatus = 'idle' | 'loading' | 'ok' | 'unavailable';

export interface ReverseQuoteState {
  amountIn: bigint | null;
  status: ReverseStatus;
}

export interface UseReverseQuoteParams {
  targetOut: bigint;
  solve: ReverseSolve | null;
  // Identity of the solver's inputs (venue, direction, tokens). `solve` itself is intentionally NOT
  // an effect dependency — callers rebuild it every render; `solveKey` says when it really changed.
  solveKey: string;
}

export function useReverseQuote({ targetOut, solve, solveKey }: UseReverseQuoteParams): ReverseQuoteState {
  const [state, setState] = useState<ReverseQuoteState>({ amountIn: null, status: 'idle' });
  const solveRef = useRef(solve);
  useEffect(() => {
    solveRef.current = solve;
  });

  useEffect(() => {
    if (targetOut <= 0n) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived async state when the input clears
      setState({ amountIn: null, status: 'idle' });
      return;
    }
    if (!solveRef.current) {
      setState({ amountIn: null, status: 'unavailable' });
      return;
    }
    setState({ amountIn: null, status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const run = solveRef.current;
      if (!run) { setState({ amountIn: null, status: 'unavailable' }); return; }
      run(targetOut, controller.signal).then(
        (amountIn) => {
          if (controller.signal.aborted) return;
          setState(amountIn === null ? { amountIn: null, status: 'unavailable' } : { amountIn, status: 'ok' });
        },
        () => {
          if (controller.signal.aborted) return;
          setState({ amountIn: null, status: 'unavailable' });
        },
      );
    }, REVERSE_QUOTE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [targetOut, solveKey]);

  return state;
}
