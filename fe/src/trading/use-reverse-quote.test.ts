import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVERSE_QUOTE_DEBOUNCE_MS, useReverseQuote } from './use-reverse-quote';
import type { ReverseSolve } from './reverse-quote';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(REVERSE_QUOTE_DEBOUNCE_MS + 1); });
}

describe('useReverseQuote', () => {
  it('is idle and never calls solve for a zero target', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 5n);
    const { result } = renderHook(() => useReverseQuote({ targetOut: 0n, solve, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'idle' });
    expect(solve).not.toHaveBeenCalled();
  });

  it('is unavailable (not an error) when there is no solver, e.g. wallet disconnected', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: null, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'unavailable' });
  });

  it('debounces, then resolves ok', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 7n);
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve, solveKey: 'k' }));
    expect(result.current.status).toBe('loading');
    expect(solve).not.toHaveBeenCalled();
    await settle();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ amountIn: 7n, status: 'ok' });
  });

  it('reports unavailable when solve returns null', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: async () => null, solveKey: 'k' }));
    await settle();
    expect(result.current).toEqual({ amountIn: null, status: 'unavailable' });
  });

  it('reports unavailable when solve throws', async () => {
    const { result } = renderHook(() => useReverseQuote({ targetOut: 10n, solve: async () => { throw new Error('x'); }, solveKey: 'k' }));
    await settle();
    expect(result.current.status).toBe('unavailable');
  });

  it('fast typing: aborts the earlier search and applies only the last target', async () => {
    const signals: AbortSignal[] = [];
    const solve = vi.fn<ReverseSolve>(async (target, signal) => { signals.push(signal); return target * 2n; });
    const { result, rerender } = renderHook(({ t }) => useReverseQuote({ targetOut: t, solve, solveKey: 'k' }), { initialProps: { t: 10n } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender({ t: 11n });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender({ t: 12n });
    await settle();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(solve).toHaveBeenCalledWith(12n, expect.anything());
    expect(result.current).toEqual({ amountIn: 24n, status: 'ok' });
  });

  it('discards a slow earlier result that resolves after a newer target started', async () => {
    let releaseFirst!: (v: bigint) => void;
    const solve = vi.fn<ReverseSolve>((target) =>
      target === 10n ? new Promise<bigint>((resolve) => { releaseFirst = resolve; }) : Promise.resolve(99n));
    const { result, rerender } = renderHook(({ t }) => useReverseQuote({ targetOut: t, solve, solveKey: 'k' }), { initialProps: { t: 10n } });
    await settle(); // first search now in flight
    rerender({ t: 20n });
    await settle();
    expect(result.current).toEqual({ amountIn: 99n, status: 'ok' });
    await act(async () => { releaseFirst(1n); });
    expect(result.current).toEqual({ amountIn: 99n, status: 'ok' });
  });

  it('re-solves when solveKey changes (e.g. direction flipped)', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 3n);
    const { rerender } = renderHook(({ k }) => useReverseQuote({ targetOut: 10n, solve, solveKey: k }), { initialProps: { k: 'a' } });
    await settle();
    rerender({ k: 'b' });
    await settle();
    expect(solve).toHaveBeenCalledTimes(2);
  });
});
