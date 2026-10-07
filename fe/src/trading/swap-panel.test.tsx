import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapPanel, type SwapToken } from './swap-panel';
import { applySlippage } from './amount';
import { UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { MSG_SENDER, ADDRESS_THIS } from './v3SwapEncoding';

const SWAP_INPUT_ABI = parseAbiParameters(
  'address recipient, uint256 amount, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36',
);
const WRAP_UNWRAP_ABI = parseAbiParameters('address, uint256');

function decodeV3SwapRecipient(swapInput: `0x${string}`): string {
  const [recipient] = decodeAbiParameters(SWAP_INPUT_ABI, swapInput);
  return (recipient as string).toLowerCase();
}

function decodeV3SwapInput(swapInput: `0x${string}`) {
  const [recipient, amount, amountOutMin, path, payerIsUser] = decodeAbiParameters(SWAP_INPUT_ABI, swapInput);
  return {
    recipient: (recipient as string).toLowerCase(),
    amount: amount as bigint,
    amountOutMin: amountOutMin as bigint,
    path: path as `0x${string}`,
    payerIsUser: payerIsUser as boolean,
  };
}

// Packed V3 path: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes), tightly packed —
// see v3SwapEncoding.ts's packV3Path and its own test's identical slicing.
function pathTokens(path: `0x${string}`): { tokenIn: string; tokenOut: string } {
  return { tokenIn: path.slice(0, 42).toLowerCase(), tokenOut: `0x${path.slice(-40)}`.toLowerCase() };
}

function decodeWrapOrUnwrap(input: `0x${string}`) {
  const [recipient, amountMinimum] = decodeAbiParameters(WRAP_UNWRAP_ABI, input);
  return { recipient: (recipient as string).toLowerCase(), amountMinimum: amountMinimum as bigint };
}

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  poolFee: 10000 as number | undefined,
  erc20Allowance: 0n,
  permit2Allowance: undefined as readonly [bigint, number, number] | undefined,
  permit2Refetch: vi.fn(async () => ({ data: hooks.permit2Allowance })),
  balanceA: 10_000_000_000_000_000_000n,
  balanceB: 10_000_000_000_000_000_000n,
  balanceNoWeth: 10_000_000_000_000_000_000n,
  nativeBalance: 10_000_000_000_000_000_000n,
  simulateData: undefined as { result: readonly [bigint, bigint, number, bigint] } | undefined,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  resetSignTypedData: vi.fn(),
  signTypedDataError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  capabilities: undefined as { atomic?: { status: 'supported' | 'ready' | 'unsupported' } } | undefined,
  sendCalls: vi.fn(),
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
    if (args.address === tokenNoWeth.address) return { data: hooks.balanceNoWeth, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: false, error: hooks.signTypedDataError, reset: hooks.resetSignTypedData }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
  useCapabilities: () => ({ data: hooks.capabilities }),
  useSendCalls: () => ({ sendCalls: hooks.sendCalls, status: 'idle', error: null, data: undefined }),
  useWaitForCallsStatus: () => ({ data: undefined, error: null }),
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
  hooks.balanceNoWeth = 10_000_000_000_000_000_000n;
  hooks.nativeBalance = 10_000_000_000_000_000_000n;
  hooks.simulateData = undefined;
  hooks.signTypedDataAsync.mockClear();
  hooks.resetSignTypedData.mockReset();
  hooks.signTypedDataError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.capabilities = undefined;
  hooks.sendCalls.mockReset();
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
    // The command byte alone doesn't prove where the wrapped ETH or the swap's payment actually
    // land — decode both inputs to confirm the real routing, not just the top-level byte.
    const wrapInput = decodeWrapOrUnwrap(args[1][0]);
    expect(wrapInput.recipient).toBe(ADDRESS_THIS.toLowerCase());
    const swapInput = decodeV3SwapInput(args[1][1]);
    expect(swapInput.payerIsUser).toBe(false); // the router itself pays, from the WETH it just wrapped
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
    // The unwrap step is what actually delivers funds to the user — decode its recipient and
    // confirm its amountMinimum is the real slippage-adjusted quoted output, not a magic number.
    const unwrapInput = decodeWrapOrUnwrap(args[1][args[1].length - 1]);
    expect(unwrapInput.recipient).toBe(MSG_SENDER.toLowerCase());
    expect(unwrapInput.amountMinimum).toBe(applySlippage(500_000_000_000_000_000n, 'auto', 'pool'));
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

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the input-side balance is insufficient (native-ETH balance, the default WETH-leg choice)', () => {
    hooks.nativeBalance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // WETH leg now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
  });

  it('does not crash and shows an "Enter an amount" label when the amount contains scientific notation', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
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

  it('keeps an explicit WETH choice (not reverted to ETH) after flipping direction, and submits via plain V3_SWAP_EXACT_IN, never WRAP_ETH', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    // tokenB (WETH) starts on the output side, defaulting to ETH — switch it to WETH explicitly.
    fireEvent.click(screen.getByRole('button', { name: /^ETH$/ }));
    fireEvent.click(screen.getByRole('option', { name: /^WETH$/ }));
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    // The WETH leg is now the input side; its choice must still read WETH, not revert to ETH.
    expect(screen.getByRole('button', { name: /^WETH$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ETH$/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ address, args, value }] = hooks.writeContract.mock.calls[0] as [
      { address: string; args: readonly [`0x${string}`, readonly `0x${string}`[], bigint]; value: bigint | undefined },
    ];
    expect(address).toBe(UNIVERSAL_ROUTER_ADDRESS);
    expect(args[0]).toBe('0x00'); // plain V3_SWAP_EXACT_IN — never 0x0b00 (WRAP_ETH)
    expect(value).toBeUndefined();
  });

  it('produces a byte-identical plain ERC20-ERC20 swap when neither side is WETH — no WRAP/UNWRAP ever injected', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ address, args, value }] = hooks.writeContract.mock.calls[0] as [
      { address: string; args: readonly [`0x${string}`, readonly `0x${string}`[], bigint]; value: bigint | undefined },
    ];
    expect(address).toBe(UNIVERSAL_ROUTER_ADDRESS);
    expect(args[0]).toBe('0x00');
    expect(value).toBeUndefined();
    const swapInput = decodeV3SwapInput(args[1][0]);
    expect(swapInput.recipient).toBe(MSG_SENDER.toLowerCase());
    expect(swapInput.payerIsUser).toBe(true);
  });

  it('is a no-op when clicking the single inert option on a non-WETH side', () => {
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /LAUNCH/ }));
    fireEvent.click(screen.getByRole('option', { name: /^LAUNCH$/ }));
    expect(screen.getByRole('button', { name: /LAUNCH/ })).toBeInTheDocument();
  });

  it('flips tokenIn/tokenOut order in the packed path when direction flips', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledTimes(1));
    const firstArgs = (hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }])[0].args;
    const firstPath = pathTokens(decodeV3SwapInput(firstArgs[1][0]).path);
    expect(firstPath.tokenIn).toBe(tokenA.address.toLowerCase());
    expect(firstPath.tokenOut).toBe(tokenNoWeth.address.toLowerCase());

    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledTimes(2));
    const secondArgs = (hooks.writeContract.mock.calls[1] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }])[0].args;
    const secondPath = pathTokens(decodeV3SwapInput(secondArgs[1][0]).path);
    expect(secondPath.tokenIn).toBe(tokenNoWeth.address.toLowerCase());
    expect(secondPath.tokenOut).toBe(tokenA.address.toLowerCase());
  });

  it('re-targets the balance check to the new input side after flipping, not left pointed at the original side', () => {
    hooks.balanceNoWeth = 0n;
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenNoWeth} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i })); // tokenNoWeth now "in"
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough USDG' })).toBeDisabled();
  });

  it('submits the swap without throwing when the deadline setting is a fractional number of minutes', () => {
    // A user who typed "1.01" into the settings popover's deadline-minutes field previously
    // crashed the click handler: deadlineMinutes * 60 = 60.6 (non-integer), and BigInt() throws a
    // RangeError on a non-integer number since only the current-timestamp half of the deadline
    // expression was floored. (A value like "10.5" would not have caught this: 10.5 * 60 = 630,
    // itself an integer, so it must be a value whose product with 60 is fractional.)
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    fireEvent.change(screen.getByLabelText(/deadline minutes/i), { target: { value: '1.01' } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Swap' }))).not.toThrow();
    expect(hooks.writeContract).toHaveBeenCalled();
  });

  it('submits approve+execute as one batch when approval is needed and the wallet supports atomic call batching', () => {
    // Default direction (tokenA "in") is already a plain ERC20 (LAUNCH, not WETH), so nativeIn is
    // false with no extra token-selector clicks needed — same fixture every other non-WETH-specific
    // test in this file already relies on.
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { atomic: { status: 'supported' } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 0n, 1, 96_633n] };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { functionName: string }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0].functionName).toBe('approve');
    expect(calls[1].functionName).toBe('execute');
  });

  it('keeps the plain two-step Approve-then-Swap flow when the wallet cannot batch calls', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { atomic: { status: 'unsupported' } };
    render(<SwapPanel poolAddress={poolAddress} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });
});
