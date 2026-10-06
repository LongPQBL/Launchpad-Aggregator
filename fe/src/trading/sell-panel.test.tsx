import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SellPanel } from './sell-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  tokenBalance: 0n,
  allowance: 0n,
  simulateData: undefined as { result: bigint } | undefined,
  simulateError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string }) => {
    if (args.functionName === 'balanceOf') return { data: hooks.tokenBalance, refetch: vi.fn() };
    return { data: hooks.allowance, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: hooks.simulateError }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.tokenBalance = 2000000000000000000n;
  hooks.allowance = 0n;
  hooks.simulateData = undefined;
  hooks.simulateError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SellPanel', () => {
  it('disables Sell when the amount is empty', () => {
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('disables Sell when the token balance is insufficient', () => {
    hooks.tokenBalance = 0n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
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

  it('shows "quote unavailable" instead of crashing if the simulated sell result cannot be decoded', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateError = new Error('could not decode result data');
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByText(/quote unavailable/i)).toBeInTheDocument();
  });

  it('keeps Sell disabled until the quote resolves, never submitting with zero slippage protection', () => {
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
  });

  it('disables Sell and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.allowance = 2000000000000000000n;
    render(<SellPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });
});
