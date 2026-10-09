import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAllTransactions, type GlobalTransaction } from '@/api/client';
import { GlobalTransactionList } from './global-transaction-list';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getAllTransactions: vi.fn() }));

function row(overrides: Partial<GlobalTransaction> = {}): GlobalTransaction {
  return {
    token: { chainId: 4663, tokenAddress: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null },
    venueId: 'v', blockNumber: '100', txHash: '0xtx1', logIndex: 0, timestamp: 1_700_000_000, side: 'buy', activityKind: 'user_trade',
    tokenAmount: '10', quoteAmount: '1', quoteAsset: { address: '0x0', symbol: 'ETH' }, traderAddress: '0x1234567890123456789012345678901234567890',
    usdValue: '2500', usdValueApprox: true, usdValueStatus: 'priced', ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('GlobalTransactionList', () => {
  it('shows each trade with a link to its launch, the side, the amounts and a compact USD value', () => {
    render(<GlobalTransactionList transactions={[row()]} nextCursor={null} />);
    const body = screen.getAllByRole('row')[1]!;
    expect(within(body).getByRole('link', { name: /ZRB/ })).toHaveAttribute('href', '/launches/4663/0xaaa');
    expect(within(body).getByText('Buy')).toBeInTheDocument();
    expect(within(body).getByText('1 ETH')).toBeInTheDocument();
    expect(within(body).getByText('$2.5K')).toBeInTheDocument();
  });

  it('shows an honest placeholder instead of a fake zero for an unpriced USD value', () => {
    render(<GlobalTransactionList transactions={[row({ usdValue: null, usdValueStatus: 'unavailable' })]} nextCursor={null} />);
    expect(within(screen.getAllByRole('row')[1]!).getByText('—')).toBeInTheDocument();
  });

  it('appends the next page with skeleton rows while it loads', async () => {
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    let resolvePage!: (page: Awaited<ReturnType<typeof getAllTransactions>>) => void;
    vi.mocked(getAllTransactions).mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
    render(<GlobalTransactionList transactions={[row()]} nextCursor="c1" />);

    act(() => intersect([{ isIntersecting: true }]));
    expect(screen.getAllByTestId('global-transaction-skeleton-row')).toHaveLength(6);
    expect(getAllTransactions).toHaveBeenCalledWith({ cursor: 'c1' });

    await act(async () => resolvePage({ items: [row({ txHash: '0xtx2', blockNumber: '99' })], nextCursor: null }));
    expect(screen.queryAllByTestId('global-transaction-skeleton-row')).toHaveLength(0);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('keeps already-loaded pages when the server refreshes the first page', async () => {
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    vi.mocked(getAllTransactions).mockResolvedValueOnce({ items: [row({ txHash: '0xtx2', blockNumber: '99' })], nextCursor: null });
    const { rerender } = render(<GlobalTransactionList transactions={[row()]} nextCursor="c1" />);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(screen.getAllByRole('row')).toHaveLength(3);

    rerender(<GlobalTransactionList transactions={[row()]} nextCursor="c1" />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});
