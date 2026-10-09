import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAllTransactions, type GlobalTransaction } from '@/api/client';
import { GlobalTransactionList } from './global-transaction-list';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getAllTransactions: vi.fn() }));

const WALLET = '0x1234567890123456789012345678901234567890';
const ZERO = '0x0000000000000000000000000000000000000000';

function row(overrides: Partial<GlobalTransaction> = {}): GlobalTransaction {
  return {
    source: 'official', pool: null,
    token: { chainId: 4663, tokenAddress: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null },
    venueId: 'v', blockNumber: '100', txHash: '0xtx1', logIndex: 0, timestamp: 1_700_000_000, side: 'buy', activityKind: 'user_trade',
    tokenAmount: '267300', quoteAmount: '0.11', quoteAsset: { address: ZERO, symbol: 'ETH', logoUri: null }, traderAddress: WALLET,
    usdValue: '2500', usdValueApprox: true, usdValueStatus: 'priced', ...overrides,
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(getAllTransactions).mockReset(); });

describe('GlobalTransactionList', () => {
  it('reads a buy as "Swap ETH for ZRB": what went out first, what came in second, USD before the amounts', () => {
    render(<GlobalTransactionList transactions={[row()]} nextCursor={null} />);
    const body = screen.getAllByRole('row')[1]!;
    expect(within(body).getByText('Swap')).toBeInTheDocument();
    const cells = within(body).getAllByRole('cell');
    // Logo placeholders add a letter, and the layout supplies the spacing, so match on the words in order.
    expect(cells[1]).toHaveTextContent(/SwapETH.*forZRB/);
    expect(within(cells[1]!).getByRole('link', { name: /ZRB/ })).toHaveAttribute('href', '/launches/4663/0xaaa');
    expect(cells[2]).toHaveTextContent('$2.5K');
    expect(cells[3]).toHaveTextContent(/^0\.11ETH/);
    expect(cells[4]).toHaveTextContent(/^267\.3KZRB/);
  });

  it('reads a sell as "Swap ZRB for ETH" with the token amount first', () => {
    render(<GlobalTransactionList transactions={[row({ side: 'sell' })]} nextCursor={null} />);
    const cells = within(screen.getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent(/SwapZRB.*forETH/);
    expect(cells[3]).toHaveTextContent(/^267\.3KZRB/);
    expect(cells[4]).toHaveTextContent(/^0\.11ETH/);
  });

  it('shows the wallet in checksum form with three dots', () => {
    render(<GlobalTransactionList transactions={[row()]} nextCursor={null} />);
    expect(screen.getByText('0x1234...7890')).toBeInTheDocument();
  });

  it('labels a protocol buyback instead of "Swap"', () => {
    render(<GlobalTransactionList transactions={[row({ activityKind: 'protocol_buyback' })]} nextCursor={null} />);
    expect(screen.getByText('Buyback by Pons')).toBeInTheDocument();
  });

  it('shows a pool swap like any other swap (no extra marker) and falls back to a short address for an unknown quote symbol', () => {
    render(<GlobalTransactionList transactions={[row({ source: 'pool', venueId: null, activityKind: null,
      pool: { protocol: 'uniswap_v4', poolId: '0xpool' }, quoteAsset: { address: '0x9999999999999999999999999999999999999999', symbol: null, logoUri: null } })]} nextCursor={null} />);
    const body = screen.getAllByRole('row')[1]!;
    expect(within(body).queryByText('(pool)')).not.toBeInTheDocument();
    expect(within(body).getAllByText('0x9999…9999').length).toBeGreaterThan(0);
  });

  it('shows an honest placeholder instead of a fake zero for an unpriced USD value', () => {
    render(<GlobalTransactionList transactions={[row({ usdValue: null, usdValueStatus: 'unavailable' })]} nextCursor={null} />);
    expect(within(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[2]!).getByText('—')).toBeInTheDocument();
  });

  it('filters rows by Buy/Sell from the Type header', () => {
    render(<GlobalTransactionList transactions={[row({ txHash: '0xa', side: 'buy' }), row({ txHash: '0xb', side: 'sell' })]} nextCursor={null} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by type' }));
    fireEvent.click(screen.getByRole('button', { name: /^Buy/ }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(within(screen.getAllByRole('row')[1]!).getByText(/Swap/)).toHaveTextContent('Swap');
  });

  it('refetches the first page for the chosen chains, with skeleton rows while it loads, and puts them in the URL', async () => {
    let resolvePage!: (page: Awaited<ReturnType<typeof getAllTransactions>>) => void;
    vi.mocked(getAllTransactions).mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
    render(<GlobalTransactionList transactions={[row()]} nextCursor={null} chainIds={[4663, 1]} />);

    fireEvent.click(screen.getByLabelText('All chains'));
    fireEvent.click(screen.getByRole('button', { name: /Robinhood Chain/ }));
    expect(getAllTransactions).toHaveBeenCalledWith({ chainId: [4663] });
    expect(screen.getAllByTestId('global-transaction-skeleton-row')).toHaveLength(8);

    await act(async () => resolvePage({ items: [row({ txHash: '0xnew', token: { chainId: 4663, tokenAddress: '0xbbb', name: 'Other', symbol: 'OTH', logoUri: null } })], nextCursor: null }));
    expect(screen.queryAllByTestId('global-transaction-skeleton-row')).toHaveLength(0);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(window.location.search).toContain('chainId=4663');
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
    expect(getAllTransactions).toHaveBeenCalledWith({ cursor: 'c1', chainId: undefined });

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
