import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTokenAllowance } from './use-token-allowance';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined },
  allowanceData: 0n as bigint | undefined,
  isFetching: false,
  refetch: vi.fn(),
  writeContract: vi.fn(),
  writePending: false,
  writeError: null as Error | null,
  writeHash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
  receiptError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: hooks.account.address }),
  useReadContract: () => ({ data: hooks.allowanceData, isFetching: hooks.isFetching, refetch: hooks.refetch }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, isPending: hooks.writePending, error: hooks.writeError, data: hooks.writeHash }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus, error: hooks.receiptError }),
}));

const token = '0x2222222222222222222222222222222222222222' as const;
const spender = '0x3333333333333333333333333333333333333333' as const;

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.allowanceData = 0n;
  hooks.isFetching = false;
  hooks.writePending = false;
  hooks.writeError = null;
  hooks.writeHash = undefined;
  hooks.receiptStatus = 'idle';
  hooks.receiptError = null;
  hooks.refetch.mockReset();
  hooks.writeContract.mockReset();
});

describe('useTokenAllowance', () => {
  it('reports the current allowance from the chain', () => {
    hooks.allowanceData = 500n;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.allowance).toBe(500n);
  });

  it('defaults to 0 while allowance is not yet loaded', () => {
    hooks.allowanceData = undefined;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.allowance).toBe(0n);
  });

  it('submits an exact-amount approve, never an infinite one', () => {
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    result.current.approve(1000n);
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: token, functionName: 'approve', args: [spender, 1000n] }),
    );
  });

  it('surfaces a decoded approval error', () => {
    hooks.writeError = new Error('User rejected the request');
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.approveError).toBe('User rejected the request');
  });

  it('reports approving while the wallet write is in flight, not yet confirming', () => {
    hooks.writePending = true;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.isApproving).toBe(true);
    expect(result.current.isConfirmingApproval).toBe(false);
  });

  it('reports confirming once the approval is broadcast but not yet mined, and does not refetch yet', () => {
    hooks.writePending = false;
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'pending';
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.isApproving).toBe(false);
    expect(result.current.isConfirmingApproval).toBe(true);
    expect(hooks.refetch).not.toHaveBeenCalled();
  });

  it('refetches the allowance only once the approval receipt confirms, not on broadcast', () => {
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'success';
    renderHook(() => useTokenAllowance(token, spender));
    expect(hooks.refetch).toHaveBeenCalled();
  });

  it('stays in a confirming state while the post-confirmation allowance refetch is in flight, not just until the receipt lands', () => {
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'success';
    hooks.isFetching = true;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    // The receipt confirmed and the refetch it triggered is still in flight — approve must not
    // be re-clickable in this window (final review, Important 1: this exact gap let a user
    // re-click Approve for one RPC round trip after confirmation).
    expect(result.current.isConfirmingApproval).toBe(true);
  });

  it('is no longer confirming once the post-confirmation refetch settles', () => {
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'success';
    hooks.isFetching = false;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.isConfirmingApproval).toBe(false);
  });

  it('does not report confirming from isFetching before any approval was ever submitted', () => {
    hooks.isFetching = true;
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.isConfirmingApproval).toBe(false);
  });

  it('surfaces a decoded error from a mined-but-reverted approval', () => {
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'error';
    hooks.receiptError = new Error('approve reverted');
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.approveError).toBe('approve reverted');
  });
});
