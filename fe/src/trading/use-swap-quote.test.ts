import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSwapQuote } from './use-swap-quote';

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

const tokenIn = '0x1111111111111111111111111111111111111111' as const;
const tokenOut = '0x2222222222222222222222222222222222222222' as const;
const recipient = '0x5555555555555555555555555555555555555555' as const;

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useSwapQuote', () => {
  it('returns the simulated output amount', () => {
    hooks.data = { result: 500000n };
    const { result } = renderHook(() =>
      useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }),
    );
    expect(result.current.outputAmount).toBe(500000n);
  });

  it('disables the simulation for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 0n, recipient }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('disables the simulation while the pool fee has not resolved yet', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: null, amountIn: 1000000n, recipient }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('passes amountOutMinimum: 0 for the quote read — the real minimum is only applied on submission', () => {
    renderHook(() => useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }));
    const args = hooks.simulateArgs as { args: [{ tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }] };
    expect(args.args[0]).toEqual({
      tokenIn, tokenOut, fee: 10000, recipient, amountIn: 1000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('pool does not exist');
    const { result } = renderHook(() =>
      useSwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1000000n, recipient }),
    );
    expect(result.current.errorMessage).toBe('pool does not exist');
  });
});
