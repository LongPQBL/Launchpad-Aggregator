import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAutoSlippageBps, useTradeSettings } from './use-trade-settings';

beforeEach(() => localStorage.clear());

describe('useTradeSettings', () => {
  it('defaults to Auto slippage, a 30 minute deadline, and 1-click trade opted out', () => {
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 'auto', deadlineMinutes: 30, oneClickTradeOptIn: false });
  });

  it('persists an update to localStorage and reflects it immediately', () => {
    const { result } = renderHook(() => useTradeSettings());
    act(() => result.current.update({ slippageBps: 100, deadlineMinutes: 10, oneClickTradeOptIn: true }));
    expect(result.current.settings).toEqual({ slippageBps: 100, deadlineMinutes: 10, oneClickTradeOptIn: true });
    expect(JSON.parse(localStorage.getItem('trade-settings')!)).toEqual({ slippageBps: 100, deadlineMinutes: 10, oneClickTradeOptIn: true });
  });

  it('loads a previously persisted value on mount', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 250, deadlineMinutes: 5, oneClickTradeOptIn: true }));
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 250, deadlineMinutes: 5, oneClickTradeOptIn: true });
  });

  it('ignores malformed stored JSON and keeps the default', () => {
    localStorage.setItem('trade-settings', '{not json');
    const { result } = renderHook(() => useTradeSettings());
    expect(result.current.settings).toEqual({ slippageBps: 'auto', deadlineMinutes: 30, oneClickTradeOptIn: false });
  });
});

describe('resolveAutoSlippageBps', () => {
  it('uses a wider default on the curve than on a graduated pool', () => {
    expect(resolveAutoSlippageBps('curve')).toBeGreaterThan(resolveAutoSlippageBps('pool'));
  });
});
