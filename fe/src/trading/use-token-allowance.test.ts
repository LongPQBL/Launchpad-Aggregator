import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTokenAllowance } from './use-token-allowance';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined },
  allowanceData: 0n as bigint | undefined,
  refetch: vi.fn(),
  writeContract: vi.fn(),
  writePending: false,
  writeError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: hooks.account.address }),
  useReadContract: () => ({ data: hooks.allowanceData, refetch: hooks.refetch }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, isPending: hooks.writePending, error: hooks.writeError }),
}));

const token = '0x2222222222222222222222222222222222222222' as const;
const spender = '0x3333333333333333333333333333333333333333' as const;

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.allowanceData = 0n;
  hooks.writePending = false;
  hooks.writeError = null;
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
      expect.anything(),
    );
  });

  it('surfaces a decoded approval error', () => {
    hooks.writeError = new Error('User rejected the request');
    const { result } = renderHook(() => useTokenAllowance(token, spender));
    expect(result.current.approveError).toBe('User rejected the request');
  });
});
