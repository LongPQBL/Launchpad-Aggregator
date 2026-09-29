import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainResourceKey, launchResourceKey, useLiveRefresh } from './use-live-refresh';

type Listener = (event: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

function latestSource(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1]!;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveRefresh', () => {
  it('coalesces repeated trade.created events into a single refetch', () => {
    const refresh = vi.fn();
    renderHook(() => useLiveRefresh([chainResourceKey(4663)], refresh));
    const source = latestSource();

    act(() => {
      source.dispatch('trade.created', { chainId: 4663 });
      source.dispatch('trade.created', { chainId: 4663 });
      source.dispatch('trade.created', { chainId: 4663 });
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores events for a chain the caller did not subscribe to', () => {
    const refresh = vi.fn();
    renderHook(() => useLiveRefresh([chainResourceKey(4663)], refresh));
    const source = latestSource();

    act(() => {
      source.dispatch('trade.created', { chainId: 1 });
      vi.runAllTimers();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the event matches a specific launch resource key', () => {
    const refresh = vi.fn();
    renderHook(() => useLiveRefresh([launchResourceKey(4663, '0xabc')], refresh));
    const source = latestSource();

    act(() => {
      source.dispatch('trade.created', { chainId: 4663, tokenAddress: '0xabc' });
      vi.runAllTimers();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports "live" status once the SSE connection opens', () => {
    const { result } = renderHook(() => useLiveRefresh([chainResourceKey(4663)], vi.fn()));
    const source = latestSource();

    act(() => {
      source.onopen?.();
    });

    expect(result.current).toBe('live');
  });

  it('falls back to polling when the SSE connection errors, and keeps refreshing periodically', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useLiveRefresh([chainResourceKey(4663)], refresh));
    const source = latestSource();

    act(() => {
      source.onerror?.();
    });
    expect(result.current).toBe('polling');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops polling once the SSE connection reconnects', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useLiveRefresh([chainResourceKey(4663)], refresh));
    const source = latestSource();

    act(() => {
      source.onerror?.();
    });
    act(() => {
      source.onopen?.();
    });
    expect(result.current).toBe('live');

    refresh.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('closes the EventSource and clears timers on unmount', () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useLiveRefresh([chainResourceKey(4663)], refresh));
    const source = latestSource();

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);

    refresh.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('resource keys', () => {
  it('builds distinct keys for a chain and for a specific launch on that chain', () => {
    expect(chainResourceKey(4663)).toBe('chain:4663');
    expect(launchResourceKey(4663, '0xABC')).toBe('launch:4663:0xabc');
    expect(chainResourceKey(4663)).not.toBe(launchResourceKey(4663, '0xabc'));
  });
});
