import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useV4SwapQuote } from './use-v4-swap-quote';
import type { V4PoolKey } from './v4SwapEncoding';

const hooks = vi.hoisted(() => ({
  data: undefined as { result: readonly [bigint, bigint] } | undefined,
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

const poolKey: V4PoolKey = {
  currency0: '0x1111111111111111111111111111111111111111',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 0, tickSpacing: 200,
  hooks: '0x3333333333333333333333333333333333333333',
};

beforeEach(() => {
  hooks.data = undefined;
  hooks.isLoading = false;
  hooks.error = null;
});

describe('useV4SwapQuote', () => {
  it('returns the quoted output amount (the first return value, not the gas estimate)', () => {
    hooks.data = { result: [500_000n, 105_006n] };
    const { result } = renderHook(() => useV4SwapQuote({ poolKey, zeroForOne: true, amountIn: 1_000_000n }));
    expect(result.current.outputAmount).toBe(500_000n);
  });

  it('disables the quote for a zero amount, never quoting a zero-amount trade', () => {
    renderHook(() => useV4SwapQuote({ poolKey, zeroForOne: true, amountIn: 0n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('disables the quote while the pool key is not yet known, rather than guessing one', () => {
    renderHook(() => useV4SwapQuote({ poolKey: undefined, zeroForOne: true, amountIn: 1_000_000n }));
    expect((hooks.simulateArgs as { query: { enabled: boolean } }).query.enabled).toBe(false);
  });

  it('passes the real pool key and direction through to the quoter call', () => {
    renderHook(() => useV4SwapQuote({ poolKey, zeroForOne: false, amountIn: 1_000_000n }));
    const args = hooks.simulateArgs as { args: [{ poolKey: V4PoolKey; zeroForOne: boolean; exactAmount: bigint; hookData: string }] };
    expect(args.args[0]).toEqual({ poolKey, zeroForOne: false, exactAmount: 1_000_000n, hookData: '0x' });
  });

  it('decodes a revert into a plain-language error message', () => {
    hooks.error = new Error('pool does not exist');
    const { result } = renderHook(() => useV4SwapQuote({ poolKey, zeroForOne: true, amountIn: 1_000_000n }));
    expect(result.current.errorMessage).toBe('pool does not exist');
  });
});
