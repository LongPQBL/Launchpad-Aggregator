import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useV3SwapQuote } from './use-v3-swap-quote';

const hooks = vi.hoisted(() => ({
  data: undefined as { result: readonly [bigint, bigint, number, bigint] } | undefined,
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

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useV3SwapQuote', () => {
  it('returns the quoted output amount (the first return value, not sqrtPriceX96After/gasEstimate)', () => {
    hooks.data = { result: [500_000n, 123n, 1, 96_633n] };
    const { result } = renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    expect(result.current.outputAmount).toBe(500_000n);
  });

  it('disables the quote for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 0n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('disables the quote while the pool fee is not yet known, never guessing a fee tier', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: null, amountIn: 1_000_000n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('passes the real tokenIn, tokenOut, amountIn, and fee through, with no sqrtPriceLimitX96 restriction', () => {
    renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    const args = hooks.simulateArgs as { args: [{ tokenIn: string; tokenOut: string; amountIn: bigint; fee: number; sqrtPriceLimitX96: bigint }] };
    expect(args.args[0]).toEqual({ tokenIn, tokenOut, amountIn: 1_000_000n, fee: 10000, sqrtPriceLimitX96: 0n });
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('pool does not exist');
    const { result } = renderHook(() => useV3SwapQuote({ tokenIn, tokenOut, fee: 10000, amountIn: 1_000_000n }));
    expect(result.current.errorMessage).toBe('pool does not exist');
  });
});
