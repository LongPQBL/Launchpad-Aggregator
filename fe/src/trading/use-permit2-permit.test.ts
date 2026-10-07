import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermit2Permit } from './use-permit2-permit';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  allowanceData: undefined as readonly [bigint, number, number] | undefined,
  isAllowanceLoading: false,
  // Defaults to mirroring whatever allowanceData is at call time (matching real refetch
  // behavior when nothing has changed on chain); individual tests override this to prove a
  // genuinely fresh value is used instead of the stale render-time `data`.
  refetch: vi.fn(async () => ({ data: hooks.allowanceData })),
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  isSigning: false,
  signError: null as Error | null,
  resetSignTypedData: vi.fn(),
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: () => ({ data: hooks.allowanceData, isLoading: hooks.isAllowanceLoading, refetch: hooks.refetch }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: hooks.isSigning, error: hooks.signError, reset: hooks.resetSignTypedData }),
}));

const token = '0x2222222222222222222222222222222222222222' as const;
const spender = '0x8876789976decbfcbbbe364623c63652db8c0904' as const;
const future = Math.floor(Date.now() / 1000) + 10_000;
const past = Math.floor(Date.now() / 1000) - 10_000;

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.allowanceData = undefined;
  hooks.isAllowanceLoading = false;
  hooks.refetch.mockReset();
  hooks.refetch.mockImplementation(async () => ({ data: hooks.allowanceData }));
  hooks.signTypedDataAsync.mockClear();
  hooks.isSigning = false;
  hooks.signError = null;
  hooks.resetSignTypedData.mockReset();
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

  it('signs with a freshly refetched nonce, not the stale render-time nonce, so a second swap in the same session never reuses a consumed nonce', async () => {
    // Render-time data says nonce 7 (e.g. from the initial mount), but the chain has since moved
    // on — a prior permit() in this same session already consumed nonce 7. A refetch right before
    // signing must see the real current nonce (42) and sign that, not the stale 7.
    hooks.allowanceData = [0n, 0, 7];
    hooks.refetch.mockImplementation(async () => ({ data: [0n, 0, 42] as const }));
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    let signed;
    await act(async () => { signed = await result.current.signPermit(); });
    expect(hooks.refetch).toHaveBeenCalled();
    expect(hooks.signTypedDataAsync).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ details: expect.objectContaining({ nonce: 42 }) }),
    }));
    expect(signed).toEqual(expect.objectContaining({
      permitSingle: expect.objectContaining({ details: expect.objectContaining({ nonce: 42 }) }),
    }));
  });

  it('returns null without signing when the fresh refetch has no usable data', async () => {
    hooks.allowanceData = [0n, 0, 7];
    hooks.refetch.mockImplementation(async () => ({ data: undefined }));
    const { result } = renderHook(() => usePermit2Permit(token, spender, 1_000_000n));
    const signed = await result.current.signPermit();
    expect(signed).toBeNull();
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });
});
