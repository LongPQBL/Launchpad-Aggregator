import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurveTradePanel } from './curve-trade-panel';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  useBalance: () => ({ data: undefined, isLoading: false }),
  useReadContract: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
}));

const curve = '0x4444444444444444444444444444444444444444' as const;
const token = '0x2222222222222222222222222222222222222222' as const;
const quoteAsset = { address: '0x0000000000000000000000000000000000000000' as const, symbol: 'ETH', decimals: 18 };

describe('CurveTradePanel', () => {
  it('defaults to the Buy tab and switches to Sell', () => {
    render(<CurveTradePanel curveAddress={curve} tokenAddress={token} tokenDecimals={18} quoteAsset={quoteAsset} explorerBase={null} />);
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Sell' }));
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument();
  });
});
