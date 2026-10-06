import { fireEvent, render, screen } from '@testing-library/react';
import { decodeFunctionData } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySlippage } from './amount';
import { SwapPanel } from './swap-panel';
import { swapRouterAbi, SWAP_ROUTER_ADDRESS } from './swapRouterAbi';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  allowance: 0n,
  allowanceIsFetching: false,
  balanceA: 10000000000000000000n,
  balanceB: 10000000000000000000n,
  poolFee: 10000 as number | undefined,
  simulateData: undefined as { result: bigint } | undefined,
  refetchQuote: vi.fn(),
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  approveTxHash: undefined as `0x${string}` | undefined,
  receiptStatus: 'idle' as 'idle' | 'pending' | 'success' | 'error',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useReadContract: (args: { functionName: string; address: string }) => {
    // `balanceOf` and `allowance` reads can both target the same ERC20 contract address (whichever
    // side is currently the input token) — discriminate on functionName first, not address alone,
    // or an allowance check would silently read back a balance value instead.
    if (args.functionName === 'fee') return { data: hooks.poolFee, isLoading: false };
    if (args.functionName === 'allowance') {
      return { data: hooks.allowance, isFetching: hooks.allowanceIsFetching, refetch: vi.fn() };
    }
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null, refetch: hooks.refetchQuote }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: hooks.approveTxHash }),
  useWaitForTransactionReceipt: () => ({ status: hooks.receiptStatus, error: null }),
}));

const poolAddress = '0x4444444444444444444444444444444444444444' as const;
const tokenA = { address: '0x1111111111111111111111111111111111111112' as const, symbol: 'LAUNCH', decimals: 18 };
const tokenB = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'WETH', decimals: 18 };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.allowance = 2000000000000000000n;
  hooks.allowanceIsFetching = false;
  hooks.balanceA = 10000000000000000000n;
  hooks.balanceB = 10000000000000000000n;
  hooks.poolFee = 10000;
  hooks.simulateData = undefined;
  hooks.refetchQuote.mockReset();
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.approveTxHash = undefined;
  hooks.receiptStatus = 'idle';
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
    // Pin the fields that protect the user's money, not just "some multicall with some BigInt" —
    // a regression that zeroed amountOutMinimum or pointed at the wrong router would still have
    // passed a looser assertion.
    const quotedOutput = 500000000000000000n;
    hooks.simulateData = { result: quotedOutput };
    const beforeTimestampSeconds = Math.floor(Date.now() / 1000);
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));

    expect(hooks.writeContract).toHaveBeenCalledTimes(1);
    const call = hooks.writeContract.mock.calls[0][0] as {
      address: string;
      functionName: string;
      args: [bigint, `0x${string}`[]];
    };
    expect(call.address).toBe(SWAP_ROUTER_ADDRESS);
    expect(call.functionName).toBe('multicall');
    const [deadline, innerCalls] = call.args;
    expect(deadline).toBeGreaterThan(BigInt(beforeTimestampSeconds));

    const decoded = decodeFunctionData({ abi: swapRouterAbi, data: innerCalls[0] });
    expect(decoded.functionName).toBe('exactInputSingle');
    const params = decoded.args[0] as { amountOutMinimum: bigint };
    // Default settings are 'auto' slippage on a pool venue — resolves to 50 bps (see
    // use-trade-settings.ts's resolveAutoSlippageBps).
    const expectedAmountOutMinimum = applySlippage(quotedOutput, 'auto', 'pool');
    expect(expectedAmountOutMinimum).not.toBe(0n);
    expect(params.amountOutMinimum).toBe(expectedAmountOutMinimum);
  });

  it('submits the swap without throwing when the deadline setting is a fractional number of minutes', () => {
    // A user who typed "1.01" into the settings popover's deadline-minutes field previously
    // crashed the click handler: deadlineMinutes * 60 = 60.6 (non-integer), and BigInt() throws a
    // RangeError on a non-integer number since only the current-timestamp half of the deadline
    // expression was floored. (A value like "10.5" would not have caught this: 10.5 * 60 = 630,
    // itself an integer, so it must be a value whose product with 60 is fractional.)
    hooks.simulateData = { result: 500000000000000000n };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    fireEvent.change(screen.getByLabelText(/deadline minutes/i), { target: { value: '1.01' } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Swap' }))).not.toThrow();
    expect(hooks.writeContract).toHaveBeenCalled();
  });

  it('refetches the quote once an approval transitions from confirming to confirmed, so a stale pre-approval "quote unavailable" error does not block Swap forever', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 500000000000000000n };
    const { rerender } = render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });

    // Approval broadcast, now confirming on-chain — isConfirmingApproval is true.
    hooks.approveTxHash = '0xabc';
    hooks.receiptStatus = 'pending';
    rerender(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(hooks.refetchQuote).not.toHaveBeenCalled();

    // Approval receipt confirms and the post-confirmation allowance refetch has settled —
    // isConfirmingApproval transitions from true to false. This is the exact transition that must
    // trigger a quote refetch; merely "isConfirmingApproval is eventually false" is not enough,
    // since that is also true before any approval ever happened.
    hooks.receiptStatus = 'success';
    hooks.allowanceIsFetching = false;
    rerender(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(hooks.refetchQuote).toHaveBeenCalled();
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
