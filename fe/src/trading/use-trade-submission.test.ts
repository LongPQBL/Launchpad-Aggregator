import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradeSubmission } from './use-trade-submission';

const hooks = vi.hoisted(() => ({
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  writeError: null as Error | null,
  hash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
  receiptError: null as Error | null,
  sendCalls: vi.fn(),
  sendStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  sendError: null as Error | null,
  sendData: undefined as { id: string } | undefined,
  callsStatusData: undefined as { status: 'pending' | 'success' | 'failure'; receipts?: { transactionHash: `0x${string}` }[] } | undefined,
  callsStatusError: null as Error | null,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: hooks.writeError, data: hooks.hash }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus, error: hooks.receiptError }),
  useSendCalls: () => ({ sendCalls: hooks.sendCalls, status: hooks.sendStatus, error: hooks.sendError, data: hooks.sendData }),
  useWaitForCallsStatus: () => ({ data: hooks.callsStatusData, error: hooks.callsStatusError }),
}));

beforeEach(() => {
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.writeError = null;
  hooks.hash = undefined;
  hooks.receiptStatus = 'idle';
  hooks.receiptError = null;
  hooks.sendCalls.mockReset();
  hooks.sendStatus = 'idle';
  hooks.sendError = null;
  hooks.sendData = undefined;
  hooks.callsStatusData = undefined;
  hooks.callsStatusError = null;
});

const call = { address: '0x4444444444444444444444444444444444444444' as const, abi: [], functionName: 'execute', args: [] };

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

  it('maps each call\'s address to "to" and requires atomic execution when submitBatch is called', () => {
    // viem's sendCalls reads call.to, not call.address (confirmed in node_modules/viem/_esm/actions/wallet/sendCalls.js) —
    // a call shaped like writeContract's {address, abi, functionName, args} has no destination at
    // all once passed straight through, so every batched call would be sent with no `to`.
    const { result } = renderHook(() => useTradeSubmission());
    const onSuccess = vi.fn();
    act(() => { result.current.submitBatch([call, call], { onSuccess }); });
    expect(hooks.sendCalls).toHaveBeenCalledWith(
      { calls: [{ to: call.address, abi: call.abi, functionName: call.functionName, args: call.args }, { to: call.address, abi: call.abi, functionName: call.functionName, args: call.args }], forceAtomic: true },
      { onSuccess },
    );
  });

  it('reports pending while the batch wallet prompt is open', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'pending';
    rerender();
    expect(result.current.status).toBe('pending');
  });

  it('reports confirming once a batch id exists but the batch status has not resolved', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    rerender();
    expect(result.current.status).toBe('confirming');
  });

  it('reports confirmed and reads txHash from the last receipt once the batch succeeds', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success', receipts: [{ transactionHash: '0x111' }, { transactionHash: '0x222' }] };
    rerender();
    expect(result.current.status).toBe('confirmed');
    expect(result.current.txHash).toBe('0x222');
  });

  it('reports failed with a decoded message when the wallet rejects the batch prompt', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'error';
    hooks.sendError = new Error('User rejected the request');
    rerender();
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBe('User rejected the request');
  });

  it('reports failed, with no decoded message, when the resolved batch status is failure', () => {
    // viem's getCallsStatus (throwOnFailure: false, the default) resolves a failed batch with
    // status: 'failure' and no error at all — TradeStatus already falls back to a generic
    // "Transaction failed." when errorMessage is null, so there is nothing to decode here.
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'failure' };
    hooks.callsStatusError = null;
    rerender();
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBeNull();
  });

  it('reports failed, not stuck confirming, when the batch status query itself errors (e.g. times out) before ever resolving', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = undefined;
    hooks.callsStatusError = new Error('Timed out while waiting for call status');
    rerender();
    expect(result.current.status).toBe('failed');
    expect(result.current.errorMessage).toBe('Timed out while waiting for call status');
  });

  it('falls back to reading single-call status once submit() is called again after an earlier submitBatch', () => {
    const { result, rerender } = renderHook(() => useTradeSubmission());
    act(() => { result.current.submitBatch([call], {}); });
    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success', receipts: [{ transactionHash: '0xbatchhash' }] };
    rerender();
    expect(result.current.status).toBe('confirmed');

    act(() => { result.current.submit(call, {}); });
    hooks.writeStatus = 'pending';
    rerender();
    expect(result.current.status).toBe('pending');
    expect(result.current.txHash).toBeUndefined();
  });
});
