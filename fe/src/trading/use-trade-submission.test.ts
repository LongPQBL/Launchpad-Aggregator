import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradeSubmission } from './use-trade-submission';

const hooks = vi.hoisted(() => ({
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  writeError: null as Error | null,
  hash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
  receiptError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: hooks.writeError, data: hooks.hash }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus, error: hooks.receiptError }),
}));

beforeEach(() => {
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.writeError = null;
  hooks.hash = undefined;
  hooks.receiptStatus = 'idle';
  hooks.receiptError = null;
});

describe('useTradeSubmission', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('idle');
  });

  it('reports pending while the wallet write is in flight', () => {
    hooks.writeStatus = 'pending';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('pending');
  });

  it('reports confirming once a hash exists but the receipt has not landed', () => {
    hooks.writeStatus = 'success';
    hooks.hash = '0xabc';
    hooks.receiptStatus = 'pending';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('confirming');
    expect(result.current.txHash).toBe('0xabc');
  });

  it('reports confirmed once the receipt lands', () => {
    hooks.writeStatus = 'success';
    hooks.hash = '0xabc';
    hooks.receiptStatus = 'success';
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('confirmed');
  });

  it('reports failed with a decoded message when the wallet write errors', () => {
    hooks.writeStatus = 'error';
    hooks.writeError = new Error('User rejected the request');
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBe('User rejected the request');
  });

  it('reports failed with the decoded receipt error when a mined transaction reverts', () => {
    hooks.writeStatus = 'success';
    hooks.hash = '0xabc';
    hooks.receiptStatus = 'error';
    hooks.receiptError = new Error('Slippage exceeded minOut');
    const { result } = renderHook(() => useTradeSubmission());
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBe('Slippage exceeded minOut');
  });
});
