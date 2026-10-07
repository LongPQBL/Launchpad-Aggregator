import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanBatchCalls } from './use-can-batch-calls';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined },
  capabilities: undefined as { atomic?: { status: 'supported' | 'ready' | 'unsupported' } } | undefined,
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
  it('returns true when the wallet reports atomic batching as supported', () => {
    hooks.capabilities = { atomic: { status: 'supported' } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(true);
  });

  it('returns false when the wallet only reports "ready", not a guaranteed commitment', () => {
    hooks.capabilities = { atomic: { status: 'ready' } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });

  it('returns false when the wallet reports atomic batching as unsupported', () => {
    hooks.capabilities = { atomic: { status: 'unsupported' } };
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });

  it('returns false when the wallet reports no atomic capability entry at all', () => {
    hooks.capabilities = {};
    const { result } = renderHook(() => useCanBatchCalls());
    expect(result.current).toBe(false);
  });
});
