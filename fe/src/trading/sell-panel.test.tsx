import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SellPanel } from './sell-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  tokenBalance: 0n,
  allowance: 0n,
  allowanceIsFetching: false,
  allowanceRefetch: vi.fn(),
  simulateData: undefined as { result: bigint } | undefined,
  simulateError: null as Error | null,
  refetchQuote: vi.fn(),
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  writePending: false,
  writeError: null as Error | null,
  writeHash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
  capabilities: undefined as Record<number, { atomic?: { status: 'supported' | 'ready' | 'unsupported' } }> | undefined,
  sendCalls: vi.fn(),
  sendStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  sendData: undefined as { id: string } | undefined,
  callsStatusData: undefined as { status: 'pending' | 'success' | 'failure' } | undefined,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return { data: hooks.tokenBalance, refetch: vi.fn() };
    return { data: hooks.allowance, isFetching: hooks.allowanceIsFetching, refetch: hooks.allowanceRefetch };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: hooks.simulateError, refetch: hooks.refetchQuote }),
  useWriteContract: () => ({
    writeContract: hooks.writeContract,
    status: hooks.writeStatus,
    isPending: hooks.writePending,
    error: hooks.writeError,
    data: hooks.writeHash,
  }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus, error: null }),
  useSendCalls: () => ({ sendCalls: hooks.sendCalls, status: hooks.sendStatus, error: null, data: hooks.sendData }),
  useWaitForCallsStatus: () => ({ data: hooks.callsStatusData, error: null }),
  useCapabilities: () => ({ data: hooks.capabilities }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  localStorage.clear();
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.tokenBalance = 2000000000000000000n;
  hooks.allowance = 0n;
  hooks.allowanceIsFetching = false;
  hooks.allowanceRefetch.mockReset();
  hooks.simulateData = undefined;
  hooks.simulateError = null;
  hooks.refetchQuote.mockReset();
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.writePending = false;
  hooks.writeError = null;
  hooks.writeHash = undefined;
  hooks.receiptStatus = 'idle';
  hooks.capabilities = undefined;
  hooks.sendCalls.mockReset();
  hooks.sendStatus = 'idle';
  hooks.sendData = undefined;
  hooks.callsStatusData = undefined;
});

describe('SellPanel', () => {
  it('shows an "Enter an amount" label when the amount is empty', () => {
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the token balance is insufficient', () => {
    hooks.tokenBalance = 0n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} tokenSymbol="MEME" quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough MEME' })).toBeDisabled();
  });

  it('always requires approval first — the launched token is never native ETH', () => {
    hooks.allowance = 0n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sell' })).not.toBeInTheDocument();
  });

  it('submits sell once allowance covers the amount', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'sell', args: [1000000000000000000n, expect.any(BigInt), '0x1111111111111111111111111111111111111111'] }),
      expect.anything(),
    );
  });

  it('refetches the quote once an approval transitions from confirming to confirmed, so a stale pre-approval "quote unavailable" error does not block Sell forever', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });

    // Approval broadcast, now confirming on-chain — isConfirmingApproval is true.
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'pending';
    rerender(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(hooks.refetchQuote).not.toHaveBeenCalled();

    // Approval receipt confirms and the post-confirmation allowance refetch has settled —
    // isConfirmingApproval transitions from true to false. This exact transition must trigger a
    // quote refetch; "isConfirmingApproval is eventually false" alone is not enough, since that
    // is also true before any approval ever happened.
    hooks.receiptStatus = 'success';
    hooks.allowanceIsFetching = false;
    rerender(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(hooks.refetchQuote).toHaveBeenCalled();
  });

  it('shows "quote unavailable" plus the real decoded error instead of crashing if the simulated sell result cannot be decoded', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateError = new Error('could not decode result data');
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByText(/quote unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/could not decode result data/i)).toBeInTheDocument();
  });

  it('keeps Sell disabled until the quote resolves, never submitting with zero slippage protection', () => {
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a decoded approval error message when the approval fails', () => {
    hooks.allowance = 0n;
    hooks.writeError = new Error('User rejected the request');
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/user rejected/i);
  });

  it('disables Sell while a submission is already in flight, to prevent a double-click double-submit', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    hooks.writeStatus = 'pending';
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('does not crash on scientific-notation input and leaves the button disabled', () => {
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(() => fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } })).not.toThrow();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('submits approve+sell as one batch when approval is needed and the wallet supports atomic call batching', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { to: string; functionName: string; args: readonly unknown[] }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ to: token, functionName: 'approve', args: [curve, 1000000000000000000n] }));
    expect(calls[1]).toEqual(expect.objectContaining({ to: curve, functionName: 'sell' }));
  });

  it('keeps the plain two-step Approve-then-Sell flow when the wallet cannot batch calls', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sell' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });

  it('refetches the launched-token allowance once a batched approve+sell confirms, so a later sell of the same token does not re-batch a redundant approve', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    expect(hooks.allowanceRefetch).not.toHaveBeenCalled();

    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success' };
    rerender(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(hooks.allowanceRefetch).toHaveBeenCalledTimes(1);
  });

  it('attempts a batch for a "ready"-status wallet once the user opts in to 1-click trade via settings', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(); // not opted in yet

    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-click trade/i }));
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
  });
});
