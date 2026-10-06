import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyPanel } from './buy-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  balance: { data: { value: 10000000000000000n }, isLoading: false },
  allowance: 0n,
  simulateData: undefined as { result: bigint } | undefined,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => hooks.balance,
  useReadContract: () => ({ data: hooks.allowance, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
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
  hooks.simulateData = undefined;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('BuyPanel', () => {
  it('disables Buy when the amount is empty', () => {
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
  });

  it('disables Buy when the native-ETH balance is insufficient, without a deposit prompt', () => {
    hooks.balance = { data: { value: 0n }, isLoading: false };
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
    expect(screen.queryByText(/deposit/i)).not.toBeInTheDocument();
  });

  it('submits buy directly with native value for a native-ETH-quoted launch, no approval step', () => {
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

  it('disables Buy and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    render(<BuyPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={nativeQuote} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });
});
