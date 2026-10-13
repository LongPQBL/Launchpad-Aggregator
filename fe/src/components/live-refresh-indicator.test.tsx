import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRADE_CREATED_EVENT } from '@/hooks/live-events';
import { launchResourceKey } from '@/hooks/resource-keys';
import { LiveRefreshIndicator } from './live-refresh-indicator';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

type Listener = (event: { data: string }) => void;
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, Set<Listener>>();
  constructor() { MockEventSource.instances.push(this); }
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(): void {}
  dispatch(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('LiveRefreshIndicator', () => {
  const token = '0x1111111111111111111111111111111111111111';

  it('announces a matching trade.created on window so list components can update without a full refresh', () => {
    const seen = vi.fn();
    window.addEventListener(TRADE_CREATED_EVENT, (event) => seen((event as CustomEvent).detail));
    render(<LiveRefreshIndicator resourceKeys={[launchResourceKey(4663, token)]} />);
    act(() => { MockEventSource.instances[0]!.dispatch('trade.created', { chainId: 4663, tokenAddress: token }); });
    expect(seen).toHaveBeenCalledWith({ chainId: 4663, tokenAddress: token });
  });

  it('does not announce launch.changed or a trade for a token it does not watch', () => {
    const seen = vi.fn();
    window.addEventListener(TRADE_CREATED_EVENT, seen);
    render(<LiveRefreshIndicator resourceKeys={[launchResourceKey(4663, token)]} />);
    act(() => {
      MockEventSource.instances[0]!.dispatch('launch.changed', { chainId: 4663, tokenAddress: token });
      MockEventSource.instances[0]!.dispatch('trade.created', { chainId: 4663, tokenAddress: '0x2222222222222222222222222222222222222222' });
    });
    expect(seen).not.toHaveBeenCalled();
  });
});
