import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V4SwapPanel } from './v4-swap-panel';
import type { V4PoolKey } from './v4SwapEncoding';

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663 },
  erc20Allowance: 0n,
  permit2Allowance: undefined as readonly [bigint, number, number] | undefined,
  balanceA: 10_000_000_000_000_000_000n,
  balanceB: 10_000_000_000_000_000_000n,
  nativeBalance: 10_000_000_000_000_000_000n,
  simulateData: undefined as { result: readonly [bigint, bigint] } | undefined,
  signTypedDataAsync: vi.fn(async () => '0xsignature' as `0x${string}`),
  writeContract: vi.fn(),
  writeStatus: 'idle' as 'idle' | 'pending' | 'error' | 'success',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => hooks.account,
  useBalance: () => ({ data: { value: hooks.nativeBalance }, isLoading: false }),
  useReadContract: (args: { functionName: string; address: string }) => {
    if (args.functionName === 'allowance' && args.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: hooks.permit2Allowance, isLoading: false };
    }
    if (args.functionName === 'allowance') return { data: hooks.erc20Allowance, isFetching: false, refetch: vi.fn() };
    if (args.address === tokenA.address) return { data: hooks.balanceA, refetch: vi.fn() };
    if (args.address === tokenB.address) return { data: hooks.balanceB, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: hooks.simulateData, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: hooks.signTypedDataAsync, isPending: false, error: null }),
  useWriteContract: () => ({ writeContract: hooks.writeContract, status: hooks.writeStatus, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
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
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.erc20Allowance = 2_000_000_000_000_000_000n;
  hooks.permit2Allowance = [2_000_000_000_000_000_000n, Math.floor(Date.now() / 1000) + 10_000, 1];
  hooks.balanceA = 10_000_000_000_000_000_000n;
  hooks.balanceB = 10_000_000_000_000_000_000n;
  hooks.simulateData = undefined;
  hooks.signTypedDataAsync.mockClear();
  hooks.writeContract.mockReset();
  hooks.writeStatus = 'idle';
});

describe('V4SwapPanel', () => {
  it('defaults to swapping tokenA for tokenB, deriving zeroForOne from the real pool key', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    expect(screen.getByText(new RegExp(`Sell.*${tokenA.symbol}`, 'i'))).toBeInTheDocument();
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

  it('disables Swap and explains why when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
    expect(screen.getByText(/switch to robinhood chain/i)).toBeInTheDocument();
  });

  it('disables Swap when the input-side balance is insufficient', () => {
    hooks.balanceA = 0n;
    hooks.simulateData = { result: [500_000_000_000_000_000n, 100_000n] };
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash and leaves Swap disabled when the amount contains scientific notation', () => {
    render(<V4SwapPanel poolKey={poolKey} tokenA={tokenA} tokenB={tokenB} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1e5' } });
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
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
});
