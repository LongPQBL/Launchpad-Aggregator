import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaymasterCapability } from './use-paymaster-capability';

type CapabilitiesMap = Record<number, { paymasterService?: { supported: boolean } }>;

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

describe('usePaymasterCapability', () => {
  it('returns true when the per-chain (4663) entry reports paymasterService as supported', () => {
    hooks.capabilities = { 4663: { paymasterService: { supported: true } } };
    const { result } = renderHook(() => usePaymasterCapability());
    expect(result.current).toBe(true);
  });

  it('returns true via the chain-agnostic (key 0) entry even when the per-chain entry is absent', () => {
    hooks.capabilities = { 0: { paymasterService: { supported: true } } };
    const { result } = renderHook(() => usePaymasterCapability());
    expect(result.current).toBe(true);
  });

  it('returns false when the per-chain entry reports supported: false', () => {
    hooks.capabilities = { 4663: { paymasterService: { supported: false } } };
    const { result } = renderHook(() => usePaymasterCapability());
    expect(result.current).toBe(false);
  });

  it('returns false when the wallet reports no paymasterService entry at all', () => {
    hooks.capabilities = { 4663: {} };
    const { result } = renderHook(() => usePaymasterCapability());
    expect(result.current).toBe(false);
  });

  it('returns false when the wallet reports no capability entries at all', () => {
    hooks.capabilities = {};
    const { result } = renderHook(() => usePaymasterCapability());
    expect(result.current).toBe(false);
  });
});
