import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyPanel } from './buy-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  paymasterServiceUrl: undefined as string | undefined,
  balance: { data: { value: 10000000000000000n }, isLoading: false },
  allowance: 0n,
  allowanceIsFetching: false,
  allowanceRefetch: vi.fn(),
  quoteBalance: 10000000000000000000n,
  simulateData: undefined as { result: bigint } | undefined,
  simulateError: null as Error | null,
  refetchQuote: vi.fn(),
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  writePending: false,
  writeError: null as Error | null,
  writeHash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
  capabilities: undefined as Record<number, { atomic?: { status: 'supported' | 'ready' | 'unsupported' }; paymasterService?: { supported: boolean } }> | undefined,
  sendCalls: vi.fn(),
  sendStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  sendData: undefined as { id: string } | undefined,
  callsStatusData: undefined as { status: 'pending' | 'success' | 'failure' } | undefined,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => hooks.balance,
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return { data: hooks.quoteBalance, refetch: vi.fn() };
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

vi.mock('./paymasterConfig', () => ({
  get PAYMASTER_SERVICE_URL() { return hooks.paymasterServiceUrl; },
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const nativeQuote = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };
const erc20Quote = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  localStorage.clear();
  hooks.paymasterServiceUrl = undefined;
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.balance = { data: { value: 10000000000000000n }, isLoading: false };
  hooks.allowance = 0n;
  hooks.allowanceIsFetching = false;
  hooks.quoteBalance = 10000000000000000000n;
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

describe('BuyPanel', () => {
  it('shows an "Enter an amount" label when the amount is empty', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('disables Buy when the native-ETH balance is insufficient, without a deposit prompt', () => {
    hooks.balance = { data: { value: 0n }, isLoading: false };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
    expect(screen.queryByText(/deposit/i)).not.toBeInTheDocument();
  });

  it('submits buy directly with native value for a native-ETH-quoted launch, no approval step', () => {
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'buy', value: 1000000000000000n }),
      expect.anything(),
    );
  });

  it('shows Approve instead of Buy for an ERC20-quoted launch with no allowance yet', () => {
    hooks.allowance = 0n;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
  });

  it('shows a disabled Buy, not Approve, when the ERC20 quote-asset balance is already known insufficient', () => {
    hooks.allowance = 0n;
    hooks.quoteBalance = 0n;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not enough USDG' })).toBeDisabled();
  });

  it('shows Buy once allowance covers the amount for an ERC20-quoted launch', () => {
    hooks.allowance = 2000000000000000000n;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows the simulated quote, formatted with the launched token\'s own decimals', () => {
    hooks.simulateData = { result: 588938000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByText(/588938/)).toBeInTheDocument();
  });

  it('keeps Buy disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
  });

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the ERC20 quote-asset balance is insufficient', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.quoteBalance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough USDG' })).toBeDisabled();
  });

  it('shows a decoded approval error message when the approval fails', () => {
    hooks.allowance = 0n;
    hooks.writeError = new Error('User rejected the request');
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/user rejected/i);
  });

  it('refetches the quote once an ERC20 approval transitions from confirming to confirmed, so a stale pre-approval "quote unavailable" error does not block Buy forever', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });

    // Approval broadcast, now confirming on-chain — isConfirmingApproval is true.
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'pending';
    rerender(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    expect(hooks.refetchQuote).not.toHaveBeenCalled();

    // Approval receipt confirms and the post-confirmation allowance refetch has settled —
    // isConfirmingApproval transitions from true to false. This exact transition must trigger a
    // quote refetch; "isConfirmingApproval is eventually false" alone is not enough, since that
    // is also true before any approval ever happened.
    hooks.receiptStatus = 'success';
    hooks.allowanceIsFetching = false;
    rerender(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    expect(hooks.refetchQuote).toHaveBeenCalled();
  });

  it('shows the real decoded quote error message instead of silently hiding it', () => {
    hooks.simulateError = new Error('could not decode result data');
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByText(/quote unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/could not decode result data/i)).toBeInTheDocument();
  });

  it('disables Buy while a submission is already in flight, to prevent a double-click double-submit', () => {
    hooks.simulateData = { result: 1000000000000000000n };
    hooks.writeStatus = 'pending';
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
  });

  it('does not crash on scientific-notation input and leaves the button disabled', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(() => fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } })).not.toThrow();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('submits approve+buy as one batch when approval is needed and the wallet supports atomic call batching', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { to: string; functionName: string; args: readonly unknown[] }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ to: erc20Quote.address, functionName: 'approve', args: [curve, 1000000000000000000n] }));
    expect(calls[1]).toEqual(expect.objectContaining({ to: curve, functionName: 'buy' }));
  });

  it('keeps the plain two-step Approve-then-Buy flow when the wallet cannot batch calls', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });

  it('refetches the quote-asset allowance once a batched approve+buy confirms, so a later buy of the same token does not re-batch a redundant approve', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(hooks.allowanceRefetch).not.toHaveBeenCalled();

    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success' };
    rerender(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    expect(hooks.allowanceRefetch).toHaveBeenCalledTimes(1);
  });

  it('attempts a batch for a "ready"-status wallet once the user opts in to 1-click trade via settings', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(); // not opted in yet

    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-click trade/i }));
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('attaches a paymasterService capability to the batch when a paymaster URL is configured and the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.paymasterServiceUrl = 'https://example.com/paymaster';
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: { paymasterService: { url: string } } }];
    expect(capabilities).toEqual({ paymasterService: { url: 'https://example.com/paymaster' } });
  });

  it('never attaches a paymasterService capability when no paymaster URL is configured, even if the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={erc20Quote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: unknown }];
    expect(capabilities).toBeUndefined();
  });
});
