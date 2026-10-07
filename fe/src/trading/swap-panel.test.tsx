import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapPanel, type SwapToken } from './swap-panel';

const SWAP_INPUT_ABI = parseAbiParameters(
  'address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36',
);

function decodeV3SwapRecipient(swapInput: `0x${string}`): string {
  const [recipient] = decodeAbiParameters(SWAP_INPUT_ABI, swapInput);
  return (recipient as string).toLowerCase();
}

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  poolFee: 10000 as number | undefined,
  erc20Allowance: 0n,
  permit2Allowance: undefined as readonly [bigint, number, number] | undefined,
  permit2Refetch: vi.fn(async () => ({ data: hooks.permit2Allowance })),
  balanceA: 10_000_000_000_000_000_000n,
  balanceB: 10_000_000_000_000_000_000n,
  nativeBalance: 10_000_000_000_000_000_000n,
  simulateData: undefined as { result: readonly [bigint, bigint, number, bigint] } | undefined,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  resetSignTypedData: vi.fn(),
  signTypedDataError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => ({ data: { value: hooks.nativeBalance }, isLoading: false }),
  useReadContract: (args: { functionName: string; address: string }) => {
    if (args.functionName === 'fee') return { data: hooks.poolFee, isLoading: false };
    if (args.functionName === 'allowance' && args.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: hooks.permit2Allowance, isLoading: false, refetch: hooks.permit2Refetch };
    }
    // The plain ERC20->Permit2 allowance check reads `allowance(owner, Permit2)` on the token's
    // own contract address (not Permit2's address, handled above) — must be distinguished from a
    // balanceOf call on that same address, or it would wrongly read back a balance as an allowance.
    if (args.functionName === 'allowance') return { data: hooks.erc20Allowance, refetch: vi.fn() };
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: false, error: hooks.signTypedDataError, reset: hooks.resetSignTypedData }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
}));

const poolAddress = '0x4444444444444444444444444444444444444444' as const;
const tokenA: SwapToken = { address: '0x1111111111111111111111111111111111111112', symbol: 'LAUNCH', decimals: 18, logoUri: null };
const tokenB: SwapToken = { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', decimals: 18, logoUri: null };
// A pair with no WETH leg at all (e.g. a Pools-tab Token/USDG pair) — for the "no native choice" cases.
const tokenNoWeth: SwapToken = { address: '0x3333333333333333333333333333333333333333', symbol: 'USDG', decimals: 18, logoUri: null };

beforeEach(() => {
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.poolFee = 10000;
  hooks.erc20Allowance = 2_000_000_000_000_000_000n;
  hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
  hooks.permit2Refetch.mockReset();
  hooks.permit2Refetch.mockImplementation(async () => ({ data: hooks.permit2Allowance }));
  hooks.balanceA = 10_000_000_000_000_000_000n;
  hooks.balanceB = 10_000_000_000_000_000_000n;
  hooks.nativeBalance = 10_000_000_000_000_000_000n;
  hooks.simulateData = undefined;
  hooks.signTypedDataAsync.mockClear();
  hooks.resetSignTypedData.mockReset();
  hooks.signTypedDataError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB, showing WETH\'s default native-ETH choice on the output side', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
    // tokenB is the WETH leg and useNativeEth defaults to true, so its selector shows ETH, not WETH.
    expect(screen.getByRole('button', { name: /^ETH$/ })).toBeInTheDocument();
  });

  it('flips direction when the toggle is clicked', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    // tokenA (not WETH) is now on the output side; tokenB (WETH, default ETH) is now on the input side.
    expect(screen.getAllByRole('button', { name: /^ETH$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
  });

  it('every side renders the token-selector chrome even when a pool has no WETH leg at all', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /USDG/ })).toBeInTheDocument();
  });

  it('shows Approve (targeting Permit2, not a router) when the ERC20->Permit2 allowance is insufficient for a WETH-chosen (non-native) input', () => {
    // Select WETH (not ETH) on the input side so this is a plain ERC20 approval case.
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('approves maxUint256 to Permit2, never an exact amount', () => {
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'approve', args: [expect.any(String), 2n ** 256n - 1n] }),
    );
  });

  it('signs a Permit2 PermitSingle then submits execute() with PERMIT2_PERMIT+V3_SWAP_EXACT_IN, for a WETH-chosen (non-native) input needing a signature', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', args: ['0x0a00', expect.arrayContaining([expect.any(String), expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
  });

  it('submits execute() with just V3_SWAP_EXACT_IN, skipping the signature, when the Permit2 allowance already covers the trade', async () => {
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', args: ['0x00', expect.arrayContaining([expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('sends value and skips both ERC20 approval and the Permit2 signature for a native-ETH-in input (the default WETH-leg choice)', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    // tokenB is WETH and the default is native ETH, so just flip direction to make it the input.
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', value: 1_000_000_000_000_000_000n }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    expect(args[0]).toBe('0x0b00'); // WRAP_ETH then V3_SWAP_EXACT_IN, no PERMIT2_PERMIT
  });

  it('appends UNWRAP_WETH and settles the swap itself to the router (ADDRESS_THIS), for a native-ETH-out output (the default WETH-leg choice)', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    // tokenB (WETH) stays the default output side; default useNativeEth=true makes this native-ETH-out.
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    expect(args[0]).toBe('0x000c'); // V3_SWAP_EXACT_IN then UNWRAP_WETH (allowance already sufficient, no permit)
    const swapInput = args[1][0];
    expect(decodeV3SwapRecipient(swapInput)).toBe('0x0000000000000000000000000000000000000002'); // ADDRESS_THIS
  });

  it('becomes immediately actionable with no Approve button and no signature when switching an already-Permit2-approved token to native-ETH-in', () => {
    // Full allowance/signature already sufficient for the ERC20 (WETH) form of this same token.
    hooks.erc20Allowance = 2_000_000_000_000_000_000n;
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // WETH leg now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    // Default choice is already native ETH — Swap must be actionable directly, no Approve.
    expect(screen.getByRole('button', { name: 'Swap' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('disables Swap and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });

  it('disables Swap when the input-side balance is insufficient (native-ETH balance, the default WETH-leg choice)', () => {
    hooks.nativeBalance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // WETH leg now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash and leaves Swap disabled when the amount contains scientific notation', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not leave an unhandled promise rejection when the wallet rejects the Permit2 signature', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    hooks.signTypedDataAsync.mockRejectedValueOnce(new Error('User rejected the request'));
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.writeContract).not.toHaveBeenCalled();
  });

  it('clears a stale Permit2 signature-rejection error as soon as a new submit begins, even one that needs no signature', async () => {
    hooks.signTypedDataError = new Error('User rejected the request');
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenB} tokenB={tokenA} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.resetSignTypedData).toHaveBeenCalled());
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });
});
