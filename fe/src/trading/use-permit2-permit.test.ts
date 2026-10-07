import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermit2Permit } from './use-permit2-permit';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  allowanceData: undefined as readonly [bigint, number, number] | undefined,
  isAllowanceLoading: false,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  isSigning: false,
  signError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: () => ({ data: hooks.allowanceData, isLoading: hooks.isAllowanceLoading }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: hooks.isSigning, error: hooks.signError }),
}));

const token = '0x2222222222222222222222222222222222222222' as const;
const spender = '0x8876789976decbfcbbbe364623c63652db8c0904' as const;
const future = Math.floor(Date.now() / 1000) + 10_000;
const past = Math.floor(Date.now() / 1000) - 10_000;

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.allowanceData = undefined;
  hooks.isAllowanceLoading = false;
  hooks.signTypedDataAsync.mockClear();
  hooks.isSigning = false;
  hooks.signError = null;
});

describe('usePermit2Permit', () => {
  it('needs a permit when no allowance has ever been granted', () => {
    hooks.allowanceData = [0n, 0, 0];
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    expect(result.current.needsPermit).toBe(true);
  });

  it('does not need a permit when the existing allowance covers the amount and has not expired', () => {
    hooks.allowanceData = [2_000_000n, future, 5];
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    expect(result.current.needsPermit).toBe(false);
  });

  it('needs a fresh permit when the existing allowance is insufficient, even if unexpired', () => {
    hooks.allowanceData = [500_000n, future, 5];
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    expect(result.current.needsPermit).toBe(true);
  });

  it('needs a fresh permit when the existing allowance has expired, even if the amount is sufficient', () => {
    hooks.allowanceData = [2_000_000n, past, 5];
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    expect(result.current.needsPermit).toBe(true);
  });

  it('signs a PermitSingle with the exact trade amount (never maxUint256) and the real nonce', async () => {
    hooks.allowanceData = [0n, 0, 7];
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    let signed;
    await act(async () => { signed = await result.current.signPermit(); });
    expect(hooks.signTypedDataAsync).toHaveBeenCalledWith(expect.objectContaining({
      domain: { name: 'Permit2', chainId: 4663, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: expect.objectContaining({
        details: expect.objectContaining({ token, amount: 1_000_000n, nonce: 7 }),
        spender,
      }),
    }));
    expect(signed).toEqual(expect.objectContaining({ signature: '0xsignature' }));
  });

  it('returns null from signPermit without calling the wallet when required inputs are missing', async () => {
    const { result } = renderHook(() => usePermit2Permit(undefined, spender, 1_000_000n));
    const signed = await result.current.signPermit();
    expect(signed).toBeNull();
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });
});
