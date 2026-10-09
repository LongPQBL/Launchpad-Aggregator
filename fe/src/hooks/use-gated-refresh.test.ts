import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_REFRESH_INTERVAL_MS, useGatedRefresh } from './use-gated-refresh';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useGatedRefresh', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); setHidden(false); });

  it('runs the first request immediately and collapses a burst into one trailing run', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useGatedRefresh(refresh));
    act(() => { result.current(); result.current(); result.current(); });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while the tab is hidden, and refreshes once when it becomes visible', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useGatedRefresh(refresh));
    act(() => setHidden(true));
    act(() => { result.current(); result.current(); });
    expect(refresh).not.toHaveBeenCalled();

    act(() => setHidden(false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
