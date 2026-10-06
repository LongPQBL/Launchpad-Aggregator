import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapPanel } from './swap-panel';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  allowance: 0n,
  balanceA: 10000000000000000000n,
  balanceB: 10000000000000000000n,
  poolFee: 10000 as number | undefined,
  simulateData: undefined as { result: bigint } | undefined,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string; address: string }) => {
    // `balanceOf` and `allowance` reads can both target the same ERC20 contract address (whichever
    // side is currently the input token) — discriminate on functionName first, not address alone,
    // or an allowance check would silently read back a balance value instead.
    if (args.functionName === 'fee') return { data: hooks.poolFee, isLoading: false };
    if (args.functionName === 'allowance') return { data: hooks.allowance, isFetching: false, refetch: vi.fn() };
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
}));

const poolAddress = '0x4444444444444444444444444444444444444444' as const;
const tokenA = { address: '0x1111111111111111111111111111111111111112' as const, symbol: 'LAUNCH', decimals: 18 };
const tokenB = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'WETH', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.allowance = 2000000000000000000n;
  hooks.balanceA = 10000000000000000000n;
  hooks.balanceB = 10000000000000000000n;
  hooks.poolFee = 10000;
  hooks.simulateData = undefined;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText(new RegExp(`Sell.*${tokenA.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('flips direction when the toggle is clicked', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    expect(screen.getByText(new RegExp(`Sell.*${tokenB.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('re-targets the balance/allowance checks to the new input side after flipping, not left pointed at the original side', () => {
    // tokenA has plenty of balance; tokenB (the input side once flipped) does not. If the balance
    // check were still hardcoded to tokenA after the flip, this would wrongly leave Swap enabled.
    hooks.balanceA = 10000000000000000000n;
    hooks.balanceB = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('disables Swap when the amount is empty', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('shows Approve instead of Swap when allowance does not cover the amount', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('submits the swap wrapped in multicall with a real deadline, once the quote resolves', () => {
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'multicall', args: expect.arrayContaining([expect.any(BigInt)]) }),
      expect.anything(),
    );
  });

  it('disables Swap and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });

  it('disables Swap when the input-side balance is insufficient', () => {
    hooks.balanceA = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash and leaves Swap disabled when the amount contains scientific notation', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });
});
