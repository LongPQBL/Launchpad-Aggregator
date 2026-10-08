import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurveSwapPanel } from './curve-swap-panel';
import { OPEN_WALLET_DIALOG_EVENT } from '@/wallet/open-wallet-dialog';

// Mock the reverse builder at its module boundary (its own tests cover the builder; here we test wiring).
const reverse = vi.hoisted(() => ({
  solve: vi.fn<(target: bigint, signal: AbortSignal) => Promise<bigint | null>>(),
  makeCurve: vi.fn(),
}));
vi.mock('./reverse-quote', () => ({
  makeCurveReverseSolve: (...args: unknown[]) => { reverse.makeCurve(...args); return reverse.solve; },
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const nativeQuote = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };
const erc20Quote = { address: '0x6666666666666666666666666666666666666666' as const, symbol: 'USDG', decimals: 18 };

const hooks = vi.hoisted(() => ({
  account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 4663, isConnected: true },
  paymasterServiceUrl: undefined as string | undefined,
  balance: { data: { value: 10000000000000000n } as { value: bigint } | undefined, isLoading: false },
  allowance: 0n,
  allowanceIsFetching: false,
  allowanceRefetch: vi.fn(),
  quoteBalance: 10000000000000000000n,
  tokenBalance: 2000000000000000000n,
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
  usePublicClient: () => ({}),
  useBalance: () => hooks.balance,
  useReadContract: (args: { functionName: string; address: string }) => {
    // balanceOf is read on whichever token is being sold: the launched token when selling, the
    // ERC20 quote asset when buying.
    if (args.functionName === 'balanceOf') {
      return { data: args.address === token ? hooks.tokenBalance : hooks.quoteBalance, refetch: vi.fn() };
    }
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

// A test that fails before its own trailing vi.useRealTimers() must not leak fake timers.
afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
  localStorage.clear();
  hooks.paymasterServiceUrl = undefined;
  hooks.account.address = '0x1111111111111111111111111111111111111111';
  hooks.account.chainId = 4663;
  hooks.account.isConnected = true;
  hooks.balance = { data: { value: 10000000000000000n }, isLoading: false };
  hooks.allowance = 0n;
  hooks.allowanceIsFetching = false;
  hooks.quoteBalance = 10000000000000000000n;
  hooks.tokenBalance = 2000000000000000000n;
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
  reverse.solve.mockReset();
  reverse.solve.mockResolvedValue(1_000_000_000_000_000_000n);
  reverse.makeCurve.mockClear();
});

type Quote = { address: `0x${string}`; symbol: string; decimals: number };
type Extra = { tokenSymbol?: string | null };
const panel = (quoteAsset: Quote, extra: Extra = {}) => (
  <CurveSwapPanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} {...extra} />
);
const flip = () => fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
const typeSell = (value: string) => fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value } });

describe('CurveSwapPanel - buy direction (default)', () => {
  it('shows an "Enter an amount" label when the amount is empty', () => {
    render(panel(nativeQuote));
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('disables Swap when the native-ETH balance is insufficient, without a deposit prompt', () => {
    hooks.balance = { data: { value: 0n }, isLoading: false };
    render(panel(nativeQuote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
    expect(screen.queryByText(/deposit/i)).not.toBeInTheDocument();
  });

  it('submits buy directly with native value for a native-ETH-quoted launch, no approval step', () => {
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'buy', value: 1000000000000000n }),
      expect.anything(),
    );
  });

  it('shows Approve instead of Swap for an ERC20-quoted launch with no allowance yet', () => {
    hooks.allowance = 0n;
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('shows a disabled "Not enough" label, not Approve, when the ERC20 quote-asset balance is already known insufficient', () => {
    hooks.allowance = 0n;
    hooks.quoteBalance = 0n;
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not enough USDG' })).toBeDisabled();
  });

  it('shows Swap once allowance covers the amount for an ERC20-quoted launch', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows the simulated quote, formatted with the launched token\'s own decimals', () => {
    hooks.simulateData = { result: 588938000000000000000000n };
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByLabelText('Buy amount')).toHaveValue(588938);
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();
  });

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the ERC20 quote-asset balance is insufficient', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.quoteBalance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Not enough USDG' })).toBeDisabled();
  });

  it('shows a decoded approval error message when the approval fails', () => {
    hooks.allowance = 0n;
    hooks.writeError = new Error('User rejected the request');
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('alert')).toHaveTextContent(/user rejected/i);
  });

  it('refetches the quote once an ERC20 approval transitions from confirming to confirmed, so a stale pre-approval "quote unavailable" error does not block Swap forever', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(panel(erc20Quote));
    typeSell('1');

    // Approval broadcast, now confirming on-chain — isConfirmingApproval is true.
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'pending';
    rerender(panel(erc20Quote));
    expect(hooks.refetchQuote).not.toHaveBeenCalled();

    // Approval receipt confirms and the post-confirmation allowance refetch has settled —
    // isConfirmingApproval transitions from true to false. This exact transition must trigger a
    // quote refetch; "isConfirmingApproval is eventually false" alone is not enough, since that
    // is also true before any approval ever happened.
    hooks.receiptStatus = 'success';
    hooks.allowanceIsFetching = false;
    rerender(panel(erc20Quote));
    expect(hooks.refetchQuote).toHaveBeenCalled();
  });

  it('shows the real decoded quote error message instead of silently hiding it', () => {
    hooks.simulateError = new Error('could not decode result data');
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByText(/quote unavailable: could not decode result data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  });

  it('disables Swap while a submission is already in flight, to prevent a double-click double-submit', () => {
    hooks.simulateData = { result: 1000000000000000000n };
    hooks.writeStatus = 'pending';
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash on scientific-notation input and leaves the button disabled', () => {
    render(panel(nativeQuote));
    expect(() => typeSell('1e5')).not.toThrow();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('submits approve+buy as one batch when approval is needed and the wallet supports atomic call batching', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { to: string; functionName: string; args: readonly unknown[] }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ to: erc20Quote.address, functionName: 'approve', args: [curve, 1000000000000000000n] }));
    expect(calls[1]).toEqual(expect.objectContaining({ to: curve, functionName: 'buy' }));
    // ERC20-quoted: the quote asset moves by transferFrom, so the buy carries no native value.
    expect((calls[1] as { value?: bigint }).value).toBeUndefined();
  });

  it('keeps the plain two-step Approve-then-Swap flow when the wallet cannot batch calls', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });

  it('refetches the quote-asset allowance once a batched approve+buy confirms, so a later buy of the same token does not re-batch a redundant approve', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = render(panel(erc20Quote));
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.allowanceRefetch).not.toHaveBeenCalled();

    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success' };
    rerender(panel(erc20Quote));
    expect(hooks.allowanceRefetch).toHaveBeenCalledTimes(1);
  });

  it('attempts a batch for a "ready"-status wallet once the user opts in to 1-click trade via settings', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(); // not opted in yet

    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    // Exact-string name: the regex /1-click trade/i also matches the "About 1-click trade" info button.
    fireEvent.click(screen.getByRole('button', { name: '1-click trade' }));
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('attaches a paymasterService capability to the batch when a paymaster URL is configured and the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.paymasterServiceUrl = 'https://example.com/paymaster';
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: { paymasterService: { url: string } } }];
    expect(capabilities).toEqual({ paymasterService: { url: 'https://example.com/paymaster' } });
  });

  it('never attaches a paymasterService capability when no paymaster URL is configured, even if the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(erc20Quote));
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: unknown }];
    expect(capabilities).toBeUndefined();
  });

  it('sends minTokensOut from applySlippage(..., "curve") on a buy', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 100, deadlineMinutes: 30, oneClickTradeOptIn: false }));
    hooks.simulateData = { result: 1000000000000000000n };
    render(panel(nativeQuote));
    typeSell('0.001');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.writeContract.mock.calls[0][0].args).toEqual([1000000000000000n, 990000000000000000n, '0x1111111111111111111111111111111111111111']);
  });
});

describe('CurveSwapPanel - sell direction (after flip)', () => {
  const sellPanel = () => panel(erc20Quote, { tokenSymbol: 'MEME' });
  const renderSell = () => {
    const result = render(sellPanel());
    flip();
    return result;
  };

  it('shows an "Enter an amount" label when the amount is empty', () => {
    renderSell();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label when the token balance is insufficient', () => {
    hooks.tokenBalance = 0n;
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Not enough MEME' })).toBeDisabled();
  });

  it('always requires approval first — the launched token is never native ETH', () => {
    hooks.allowance = 0n;
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
  });

  it('always requires approval first even when the quote asset is native ETH', () => {
    hooks.allowance = 0n;
    render(panel(nativeQuote, { tokenSymbol: 'MEME' }));
    flip();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('submits sell once allowance covers the amount', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: curve, functionName: 'sell', args: [1000000000000000000n, expect.any(BigInt), '0x1111111111111111111111111111111111111111'] }),
      expect.anything(),
    );
  });

  it('sends minQuoteOut from applySlippage(..., "curve") on a sell, and no native value', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 100, deadlineMinutes: 30, oneClickTradeOptIn: false }));
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [call] = hooks.writeContract.mock.calls[0] as [{ args: unknown[]; value?: bigint }];
    expect(call.args).toEqual([1000000000000000000n, 990000000000000000n, '0x1111111111111111111111111111111111111111']);
    expect(call.value).toBeUndefined();
  });

  it('refetches the quote once an approval transitions from confirming to confirmed, so a stale pre-approval "quote unavailable" error does not block Swap forever', () => {
    hooks.allowance = 0n;
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = renderSell();
    typeSell('1');

    // Approval broadcast, now confirming on-chain — isConfirmingApproval is true.
    hooks.writeHash = '0xabc';
    hooks.receiptStatus = 'pending';
    rerender(sellPanel());
    expect(hooks.refetchQuote).not.toHaveBeenCalled();

    // Approval receipt confirms and the post-confirmation allowance refetch has settled —
    // isConfirmingApproval transitions from true to false. This exact transition must trigger a
    // quote refetch; "isConfirmingApproval is eventually false" alone is not enough, since that
    // is also true before any approval ever happened.
    hooks.receiptStatus = 'success';
    hooks.allowanceIsFetching = false;
    rerender(sellPanel());
    expect(hooks.refetchQuote).toHaveBeenCalled();
  });

  it('shows "quote unavailable" plus the real decoded error instead of crashing if the simulated sell result cannot be decoded', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateError = new Error('could not decode result data');
    renderSell();
    typeSell('1');
    expect(screen.getByText(/quote unavailable: could not decode result data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  });

  it('keeps Swap disabled until the quote resolves, never submitting with zero slippage protection', () => {
    hooks.allowance = 2000000000000000000n;
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();
  });

  it('shows a "Switch network" label when the wallet is connected to a chain other than Robinhood Chain', () => {
    hooks.account.chainId = 1;
    hooks.allowance = 2000000000000000000n;
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows a decoded approval error message when the approval fails', () => {
    hooks.allowance = 0n;
    hooks.writeError = new Error('User rejected the request');
    renderSell();
    typeSell('1');
    expect(screen.getByRole('alert')).toHaveTextContent(/user rejected/i);
  });

  it('disables Swap while a submission is already in flight, to prevent a double-click double-submit', () => {
    hooks.allowance = 2000000000000000000n;
    hooks.simulateData = { result: 1000000000000000000n };
    hooks.writeStatus = 'pending';
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('does not crash on scientific-notation input and leaves the button disabled', () => {
    hooks.allowance = 2000000000000000000n;
    renderSell();
    expect(() => typeSell('1e5')).not.toThrow();
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('submits approve+sell as one batch when approval is needed and the wallet supports atomic call batching', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
    const [{ calls }] = hooks.sendCalls.mock.calls[0] as [{ calls: { to: string; functionName: string; args: readonly unknown[] }[] }];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({ to: token, functionName: 'approve', args: [curve, 1000000000000000000n] }));
    expect(calls[1]).toEqual(expect.objectContaining({ to: curve, functionName: 'sell' }));
  });

  it('keeps the plain two-step Approve-then-Swap flow when the wallet cannot batch calls', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'unsupported' } } };
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument();
    expect(hooks.sendCalls).not.toHaveBeenCalled();
  });

  it('refetches the launched-token allowance once a batched approve+sell confirms, so a later sell of the same token does not re-batch a redundant approve', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    const { rerender } = renderSell();
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.allowanceRefetch).not.toHaveBeenCalled();

    hooks.sendStatus = 'success';
    hooks.sendData = { id: '0xbatch' };
    hooks.callsStatusData = { status: 'success' };
    rerender(sellPanel());
    expect(hooks.allowanceRefetch).toHaveBeenCalledTimes(1);
  });

  it('attempts a batch for a "ready"-status wallet once the user opts in to 1-click trade via settings', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'ready' } } };
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(); // not opted in yet

    fireEvent.click(screen.getByRole('button', { name: /trade settings/i }));
    // Exact-string name: the regex /1-click trade/i also matches the "About 1-click trade" info button.
    fireEvent.click(screen.getByRole('button', { name: '1-click trade' }));
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(hooks.sendCalls).toHaveBeenCalledTimes(1);
  });

  it('attaches a paymasterService capability to the batch when a paymaster URL is configured and the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.paymasterServiceUrl = 'https://example.com/paymaster';
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: { paymasterService: { url: string } } }];
    expect(capabilities).toEqual({ paymasterService: { url: 'https://example.com/paymaster' } });
  });

  it('never attaches a paymasterService capability when no paymaster URL is configured, even if the wallet reports support', () => {
    hooks.allowance = 0n;
    hooks.capabilities = { 4663: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
    hooks.simulateData = { result: 1000000000000000000n };
    renderSell();
    typeSell('1');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const [{ capabilities }] = hooks.sendCalls.mock.calls[0] as [{ capabilities?: unknown }];
    expect(capabilities).toBeUndefined();
  });
});

describe('button states', () => {
  it('Connect when no wallet is connected; clicking it asks the header to open the wallet dialog', () => {
    hooks.account.isConnected = false;
    hooks.account.address = undefined;
    const handler = vi.fn();
    window.addEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
    render(panel(nativeQuote));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_WALLET_DIALOG_EVENT, handler);
  });

  it('walks Getting quote… → Not enough ETH → Swap for a native-ETH buy', () => {
    hooks.simulateData = undefined; // forward quote not back yet
    const { rerender } = render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();

    hooks.simulateData = { result: 5n * 10n ** 20n };
    hooks.balance = { data: { value: 0n }, isLoading: false }; // no ETH
    rerender(panel(nativeQuote));
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();

    hooks.balance = { data: { value: 10n ** 18n }, isLoading: false };
    rerender(panel(nativeQuote));
    expect(screen.getByRole('button', { name: 'Swap' })).toBeEnabled();
  });
});

describe('two-way amounts', () => {
  it('buy direction: typing in Buy derives the quote-asset amount from the curve reverse solver', async () => {
    vi.useFakeTimers();
    render(panel(nativeQuote));
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '10' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.makeCurve).toHaveBeenCalledWith({}, { curveAddress: curve, direction: 'buy', tokenAddress: token, quoteAssetAddress: nativeQuote.address, isNativeQuote: true });
    expect(reverse.solve).toHaveBeenCalledWith(10_000_000_000_000_000_000n, expect.anything());
    expect(screen.getByLabelText('Sell amount')).toHaveValue(1);
    vi.useRealTimers();
  });

  it('sell direction (after flip): the solver is built for sell', async () => {
    vi.useFakeTimers();
    render(panel(erc20Quote));
    flip();
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.makeCurve).toHaveBeenLastCalledWith({}, { curveAddress: curve, direction: 'sell', tokenAddress: token, quoteAssetAddress: erc20Quote.address, isNativeQuote: false });
    vi.useRealTimers();
  });

  it('shows "Quote unavailable" and disables the button when the reverse solver has no answer', async () => {
    vi.useFakeTimers();
    reverse.solve.mockResolvedValue(null);
    render(panel(erc20Quote));
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    // Two matches: the Sell card hint and the button label.
    expect(screen.getAllByText('Quote unavailable')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
    vi.useRealTimers();
  });

  it('works without a connected wallet: the reverse solver does not depend on the account', async () => {
    vi.useFakeTimers();
    hooks.account.address = undefined;
    render(panel(nativeQuote));
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '5' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(reverse.solve).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Sell amount')).toHaveValue(1);
    vi.useRealTimers();
  });

  it('flipping switches the venue call (buy ⇄ sell), keeps the typed number, and the badge stays "Bonding curve"', () => {
    render(panel(nativeQuote));
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
    typeSell('5');
    flip();
    expect(screen.getByLabelText('Buy amount')).toHaveValue(5);
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
  });

  it('shows Min received using curve slippage: the same minTokensOut that is submitted', () => {
    localStorage.setItem('trade-settings', JSON.stringify({ slippageBps: 100, deadlineMinutes: 30, oneClickTradeOptIn: false }));
    hooks.simulateData = { result: 1_000_000_000_000_000_000_000n }; // forward quote: 1000 tokens
    render(panel(nativeQuote));
    typeSell('0.001');
    expect(screen.getByText('Min received')).toBeInTheDocument();
    expect(screen.getByText(/^990/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    // 990e18 raw must equal the minTokensOut argument actually sent to buy()
    expect(hooks.writeContract.mock.calls[0][0].args[1]).toBe(990_000_000_000_000_000_000n);
  });

  it('has no Buy/Sell/Limit tabs', () => {
    render(panel(nativeQuote));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
