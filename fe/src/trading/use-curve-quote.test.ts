import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useCurveQuote } from './use-curve-quote';

const hooks = vi.hoisted(() => ({
  data: undefined as { result: bigint } | undefined,
  isLoading: false,
  error: null as Error | null,
  simulateArgs: undefined as unknown,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useSimulateContract: (args: unknown) => {
    hooks.simulateArgs = args;
    return { data: hooks.data, isLoading: hooks.isLoading, error: hooks.error };
  },
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const recipient = '0x5555555555555555555555555555555555555555' as const;

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useCurveQuote', () => {
  it('returns the simulated output amount for a buy', () => {
    hooks.data = { result: 588938n };
    const { result } = renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 1000000000000000n, recipient, nativeValue: 1000000000000000n }),
    );
    expect(result.current.outputAmount).toBe(588938n);
  });

  it('disables the simulation for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 0n, recipient, nativeValue: 0n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('CurveGraduated reverted');
    const { result } = renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'buy', amountIn: 1000000000000000n, recipient, nativeValue: 1000000000000000n }),
    );
    expect(result.current.errorMessage).toBe('CurveGraduated reverted');
  });

  it('passes minTokensOut: 0 for a buy quote and minQuoteOut: 0 for a sell quote', () => {
    renderHook(() =>
      useCurveQuote({ curveAddress: curve, direction: 'sell', amountIn: 1000n, recipient, nativeValue: undefined }),
    );
    expect((hooks.simulateArgs as { args: unknown[] }).args).toEqual([1000n, 0n, recipient]);
  });
});
