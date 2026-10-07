import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurveTradePanel } from './curve-trade-panel';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined, chainId: 4663 }),
  useBalance: () => ({ data: { value: 1_000_000_000_000_000_000n }, isLoading: false }),
  useReadContract: () => ({ data: 1_000_000_000_000_000_000n, isLoading: false, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: { result: 1_000_000_000_000_000_000n }, isLoading: false, error: null, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
  useSendCalls: () => ({ sendCalls: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForCallsStatus: () => ({ data: undefined, error: null }),
  useCapabilities: () => ({ data: undefined }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };

describe('CurveTradePanel', () => {
  it('defaults to the Buy tab and switches to Sell', () => {
    render(<CurveTradePanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Sell' }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument();
  });
});
