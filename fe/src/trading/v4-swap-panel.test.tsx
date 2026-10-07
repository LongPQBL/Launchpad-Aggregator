import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeAbiParameters, maxUint256, parseAbiParameters } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V4SwapPanel } from './v4-swap-panel';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import type { V4PoolKey } from './v4SwapEncoding';

// Mirrors v4SwapEncoding.test.ts's own decode pattern: actions string, then each params[]
// element decoded by position (params[0] is the swap struct itself).
const SWAP_PARAMS_ABI = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
);

function decodeZeroForOne(swapInput: `0x${string}`): boolean {
  const [, params] = decodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), swapInput);
  const [swapParams] = decodeAbiParameters(SWAP_PARAMS_ABI, params[0]);
  return swapParams.zeroForOne;
}

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  erc20Allowance: 0n,
  permit2Allowance: undefined as readonly [bigint, number, number] | undefined,
  // Mirrors permit2Allowance at call time by default (same convention as
  // use-permit2-permit.test.ts's own refetch mock); tests that need a rejecting signature can
  // still override signTypedDataAsync below without needing to touch this.
  permit2Refetch: vi.fn(async () => ({ data: hooks.permit2Allowance })),
  balanceA: 10_000_000_000_000_000_000n,
  balanceB: 10_000_000_000_000_000_000n,
  nativeBalance: 10_000_000_000_000_000_000n,
  simulateData: undefined as { result: readonly [bigint, bigint] } | undefined,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  resetSignTypedData: vi.fn(),
  signTypedDataError: null as Error | null,
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  capabilities: undefined as Record<number, { atomic?: { status: 'supported' | 'ready' | 'unsupported' }; paymasterService?: { supported: boolean } }> | undefined,
  paymasterServiceUrl: undefined as string | undefined,
  sendCalls: vi.fn(),
  sendStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
  sendData: undefined as { id: string } | undefined,
  callsStatusData: undefined as { status: 'pending' | 'success' | 'failure' } | undefined,
  erc20AllowanceRefetch: vi.fn(),
  erc20AllowanceLoading: false,
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => ({ data: { value: hooks.nativeBalance }, isLoading: false }),
  useReadContract: (args: { functionName: string; address: string }) => {
    if (args.functionName === 'allowance' && args.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: hooks.permit2Allowance, isLoading: false, refetch: hooks.permit2Refetch };
    }
    if (args.functionName === 'allowance') return { data: hooks.erc20Allowance, isLoading: hooks.erc20AllowanceLoading, isFetching: false, refetch: hooks.erc20AllowanceRefetch };
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: false, error: hooks.signTypedDataError, reset: hooks.resetSignTypedData }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
  useCapabilities: () => ({ data: hooks.capabilities }),
  useSendCalls: () => ({ sendCalls: hooks.sendCalls, status: hooks.sendStatus, error: null, data: hooks.sendData }),
  useWaitForCallsStatus: () => ({ data: hooks.callsStatusData, error: null }),
}));

vi.mock('./paymasterConfig', () => ({
  get PAYMASTER_SERVICE_URL() { return hooks.paymasterServiceUrl; },
}));

const poolKey: V4PoolKey = {
  currency0: '0x1111111111111111111111111111111111111112',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 0, tickSpacing: 200,
  hooks: '0x3333333333333333333333333333333333333333',
};
const tokenA = { address: poolKey.currency0, symbol: 'LAUNCH', decimals: 18 };
const tokenB = { address: poolKey.currency1, symbol: 'ROBIN', decimals: 18 };

beforeEach(() => {
  localStorage.clear();
  hooks.paymasterServiceUrl = undefined;
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.erc20Allowance = 2_000_000_000_000_000_000n;
  hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
  hooks.permit2Refetch.mockReset();
  hooks.permit2Refetch.mockImplementation(async () => ({ data: hooks.permit2Allowance }));
  hooks.balanceA = 10_000_000_000_000_000_000n;
  hooks.balanceB = 10_000_000_000_000_000_000n;
  hooks.simulateData = undefined;
  hooks.signTypedDataAsync.mockClear();
  hooks.resetSignTypedData.mockReset();
  hooks.signTypedDataError = null;
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
  hooks.capabilities = undefined;
  hooks.sendCalls.mockReset();
  hooks.sendStatus = 'idle';
  hooks.sendData = undefined;
  hooks.callsStatusData = undefined;
  hooks.erc20AllowanceRefetch.mockReset();
  hooks.erc20AllowanceLoading = false;
});

describe('V4SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB, deriving zeroForOne from the real pool key', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText(new RegExp(`Sell.*${tokenA.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('encodes the real zeroForOne bit matching the UI direction, not just the displayed label', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    const inputs = args[1];
    expect(decodeZeroForOne(inputs[inputs.length - 1])).toBe(true);
  });

  it('flips the encoded zeroForOne bit to false after the direction toggle, not just the displayed label', async () => {
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalled());
    const [{ args }] = hooks.writeContract.mock.calls[0] as [{ args: readonly [`0x${string}`, readonly `0x${string}`[], bigint] }];
    const inputs = args[1];
    expect(decodeZeroForOne(inputs[inputs.length - 1])).toBe(false);
  });

  it('flips direction when the toggle is clicked', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    expect(screen.getByText(new RegExp(`Sell.*${tokenB.symbol}`, 'i'))).toBeInTheDocument();
  });

  it('shows Approve (targeting Permit2, not the router) when the ERC20->Permit2 allowance is insufficient', () => {
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('approves maxUint256 to Permit2, never an exact amount, for this one step', () => {
    hooks.erc20Allowance = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    // useTokenAllowance.approve() calls writeContract with a single argument (no onSuccess
    // options), same as the existing use-token-allowance.test.ts convention — unlike the
    // execute() submissions below, there is no second call argument to assert here.
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'approve', args: [expect.any(String), 2n ** 256n - 1n] }),
    );
  });

  it('signs a Permit2 PermitSingle then submits execute() with PERMIT2_PERMIT+V4_SWAP, when the Permit2 allowance is insufficient', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      // args is [commands, inputs, deadline] — a third positional element (the deadline) always
      // follows commands/inputs per universalRouterAbi's execute() signature, so it needs its own
      // placeholder matcher here, not just the two elements this started with.
      expect.objectContaining({ functionName: 'execute', args: ['0x0a10', expect.arrayContaining([expect.any(String), expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
  });

  it('submits execute() with just V4_SWAP, skipping the signature, when the Permit2 allowance already covers the trade', async () => {
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      // Same third-element note as above: args is [commands, inputs, deadline], not just two.
      expect.objectContaining({ functionName: 'execute', args: ['0x10', expect.arrayContaining([expect.any(String)]), expect.anything()] }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the input-side balance is insufficient', () => {
    hooks.balanceA = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough LAUNCH' })).toBeDisabled();
  });

  it('re-targets the balance/allowance checks to the new input side after flipping, not left pointed at the original side', () => {
    // tokenA has plenty of balance; tokenB (the input side once flipped) does not. If the balance
    // check were still hardcoded to tokenA after the flip, this would wrongly leave Swap enabled.
    hooks.balanceA = 10_000_000_000_000_000_000n;
    hooks.balanceB = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.click(screen.getByRole('button', { name: /flip|swap direction/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Not enough ROBIN' })).toBeDisabled();
  });

  it('does not crash and shows an "Enter an amount" label when the amount contains scientific notation', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('does not leave an unhandled promise rejection when the wallet rejects the Permit2 signature', async () => {
    hooks.permit2Allowance = [0n, 0, 2];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    hooks.signTypedDataAsync.mockRejectedValueOnce(new Error('User rejected the request'));
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.signTypedDataAsync).toHaveBeenCalledTimes(1));
    // Give a would-be unhandled rejection a turn to surface before asserting the flow stopped
    // cleanly — submitSwap must swallow the rejection (signError from the hook already reflects
    // it) rather than let it escape the void-called click handler.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.writeContract).not.toHaveBeenCalled();
  });

  it('skips both the ERC20 approval and the Permit2 signature for a native-ETH input, sending value instead', async () => {
    const nativePoolKey: V4PoolKey = { ...poolKey, currency0: '0x0000000000000000000000000000000000000000' };
    const nativeTokenA = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={nativePoolKey} tokenA={nativeTokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execute', value: 1_000_000_000_000_000_000n }),
      expect.anything(),
    ));
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('clears a stale Permit2 signature-rejection error as soon as a new submit begins, even one that needs no signature', async () => {
    // Simulate a prior attempt's rejected signature: useSignTypedData's own error state is
    // already set, so the stale message is showing, even though this submit's allowance already
    // covers the trade and will never call signTypedDataAsync again.
    hooks.signTypedDataError = new Error('User rejected the request');
    hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(hooks.resetSignTypedData).toHaveBeenCalled());
    expect(hooks.signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('submits approve+execute as one batch when approval is needed and the wallet supports atomic call batching', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { to: string; functionName: string; args: readonly unknown[] }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ to: tokenA.address, functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] }));
    expect(calls[1]).toEqual(expect.objectContaining({ to: UNIVERSAL_ROUTER_ADDRESS, functionName: 'execute' }));
  });

  it('keeps the plain two-step Approve-then-Swap flow when the wallet cannot batch calls', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });

  it('refetches the ERC20->Permit2 allowance once a batched approve+swap confirms, so a later swap of the same token does not re-batch a redundant approve', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    const { rerender } = render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.erc20AllowanceRefetch).not.toHaveBeenCalled();

    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success' };
    rerender(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(hooks.erc20AllowanceRefetch).toHaveBeenCalledTimes(1);
  });

  it('attempts a batch for a "ready"-status wallet once the user opts in to 1-click trade via settings', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(); // not opted in yet

    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-click trade/i }));
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('attaches a paymasterService capability to the batch when a paymaster URL is configured and the wallet reports support', () => {
    hooks.erc20Allowance = 0n;
    hooks.paymasterServiceUrl = 'https://example.com/paymaster';
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: { paymasterService: { url: string } } }];
    expect(capabilities).toEqual({ paymasterService: { url: 'https://example.com/paymaster' } });
  });

  it('never attaches a paymasterService capability when no paymaster URL is configured, even if the wallet reports support', () => {
    hooks.erc20Allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: unknown }];
    expect(capabilities).toBeUndefined();
  });

  it('keeps Swap disabled while the ERC20->Permit2 allowance is still loading, instead of assuming approval is unnecessary', () => {
    hooks.erc20Allowance = 0n;
    hooks.erc20AllowanceLoading = true;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });
});
