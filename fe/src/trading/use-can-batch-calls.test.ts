import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanBatchCalls } from './use-can-batch-calls';

type CapabilitiesMap = Record<number, { atomic?: { status: 'supported' | 'ready' | 'unsupported' } }>;

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined },
  capabilities: undefined as CapabilitiesMap | undefined,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useCapabilities: () => ({ data: hooks.capabilities }),
}));

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.capabilities = undefined;
});

describe('useCanBatchCalls', () => {
  it('returns true when the per-chain (4663) entry reports atomic batching as supported', () => {
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(true);
  });

  it('returns true via the chain-agnostic (key 0) entry even when the per-chain entry is absent', () => {
    // EIP-5792 v2 wallets may report capabilities under the chain-agnostic key 0x0 (which
    // viem's getCapabilities normalizes to the numeric key 0) instead of, or in addition to, the
    // specific chain. Passing a concrete chainId to useCapabilities would silently discard this.
    hooks.capabilities = { 0: { atomic: { status: 'supported' } } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(true);
  });

  it('returns false when only "ready", not a guaranteed commitment, is reported on either key, by default', () => {
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } }, 0: { atomic: { status: 'ready' } } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });

  it('returns false when the per-chain entry reports unsupported, even if present', () => {
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });

  it('returns false when the wallet reports no capability entries at all', () => {
    hooks.capabilities = {};
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });

  it('returns true for a "ready" per-chain entry when the user has opted in to 1-click trade', () => {
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    const { result } = renderHook(() => useCanBatchCalls(true));
    expect(result.current).toBe(true);
  });

  it('returns true for a "ready" chain-agnostic (key 0) entry when the user has opted in to 1-click trade', () => {
    hooks.capabilities = { 0: { atomic: { status: 'ready' } } };
    const { result } = renderHook(() => useCanBatchCalls(true));
    expect(result.current).toBe(true);
  });

  it('stays false for "unsupported" even when the user has opted in to 1-click trade', () => {
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    const { result } = renderHook(() => useCanBatchCalls(true));
    expect(result.current).toBe(false);
  });
});
