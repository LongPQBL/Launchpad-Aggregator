import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyPanel } from './buy-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  balance: { data: { value: 10000000000000000n }, isLoading: false },
  allowance: 0n,
  allowanceIsFetching: false,
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
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => hooks.balance,
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return { data: hooks.quoteBalance, refetch: vi.fn() };
    return { data: hooks.allowance, isFetching: hooks.allowanceIsFetching, refetch: vi.fn() };
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
  useSendCalls: () => ({ sendCalls: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForCallsStatus: () => ({ data: undefined, error: null }),
  useCapabilities: () => ({ data: undefined }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const nativeQuote = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };
const erc20Quote = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.balance = { data: { value: 10000000000000000n }, isLoading: false };
  hooks.allowance = 0n;
  hooks.allowanceIsFetching = false;
  hooks.quoteBalance = 10000000000000000000n;
  hooks.simulateData = undefined;
  hooks.simulateError = null;
  hooks.refetchQuote.mockReset();
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.writePending = false;
  hooks.writeError = null;
  hooks.writeHash = undefined;
  hooks.receiptStatus = 'idle';
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
});
