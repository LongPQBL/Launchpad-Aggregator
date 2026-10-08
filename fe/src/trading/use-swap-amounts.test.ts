import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVERSE_QUOTE_DEBOUNCE_MS } from './use-reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import type { ReverseSolve } from './reverse-quote';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(REVERSE_QUOTE_DEBOUNCE_MS + 1); });

function setup(solve: ReverseSolve | null = async (t) => t * 2n) {
  return renderHook(() => useSwapAmounts({ tokenInDecimals: 18, tokenOutDecimals: 6, solve, solveKey: 'k' }));
}

describe('useSwapAmounts', () => {
  it('starts empty with the Sell side as the source', () => {
    const { result } = setup();
    expect(result.current).toMatchObject({ source: 'sell', typed: '', amountIn: 0n, sellText: '', buyTypedText: '' });
  });

  it('typing in Sell: amountIn is the parsed Sell amount, no reverse quote runs', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 1n);
    const { result } = setup(solve);
    act(() => result.current.onSellChange('1.5'));
    await settle();
    expect(result.current).toMatchObject({ source: 'sell', typed: '1.5', amountIn: 1_500_000_000_000_000_000n, sellText: '1.5', buyTypedText: '' });
    expect(solve).not.toHaveBeenCalled();
  });

  it('typing in Buy: amountIn comes from the reverse quote and the Sell text shows it', async () => {
    const { result } = setup(async (target) => target * 10n ** 12n); // 6-dec target -> 18-dec input
    act(() => result.current.onBuyChange('2'));
    expect(result.current).toMatchObject({ source: 'buy', typed: '2', buyTypedText: '2', amountIn: 0n, sellText: '' });
    await settle();
    expect(result.current.amountIn).toBe(2_000_000n * 10n ** 12n);
    expect(result.current.sellText).toBe('2');
    expect(result.current.reverseStatus).toBe('ok');
  });

  it('typing in Buy with an unsolvable target: amountIn stays 0 and status is unavailable', async () => {
    const { result } = setup(async () => null);
    act(() => result.current.onBuyChange('999999'));
    await settle();
    expect(result.current).toMatchObject({ amountIn: 0n, sellText: '', reverseStatus: 'unavailable' });
  });

  it('flip keeps the typed number on the same token by moving the source to the other side', () => {
    const { result } = setup();
    act(() => result.current.onSellChange('5'));
    act(() => result.current.flip());
    expect(result.current).toMatchObject({ source: 'buy', typed: '5', buyTypedText: '5', sellText: '' });
    act(() => result.current.flip());
    expect(result.current).toMatchObject({ source: 'sell', typed: '5', sellText: '5' });
  });

  it('garbage input yields zero amounts and never calls the solver', async () => {
    const solve = vi.fn<ReverseSolve>(async () => 1n);
    const { result } = setup(solve);
    for (const bad of ['.', '1e5', 'abc', '-1']) {
      act(() => result.current.onBuyChange(bad));
      await settle();
      expect(result.current.amountIn).toBe(0n);
    }
    expect(solve).not.toHaveBeenCalled();
  });

  it('reset clears the typed amount', () => {
    const { result } = setup();
    act(() => result.current.onSellChange('5'));
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ typed: '', amountIn: 0n });
  });
});
