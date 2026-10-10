import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficialVenue, Transaction } from '@/api/client';
import { getLaunchTransactions } from '@/api/client';
import { TransactionList } from './transaction-list';

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getLaunchTransactions: vi.fn(),
}));

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    source: 'official', venueId: 'pons-v2-curve:0xtoken', pool: null,
    blockNumber: '100', txHash: '0xtx1', logIndex: 0, timestamp: 1_700_000_000,
    side: 'buy', activityKind: 'user_trade', tokenAmount: '10', quoteAmount: '1',
    quoteAssetAddress: '0xquote', traderAddress: '0x1234567890123456789012345678901234567890',
    usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable',
    ...overrides,
  };
}

const noVenues: readonly OfficialVenue[] = [];
const quoteAsset = { address: '0xquote', symbol: 'ROBIN' };

describe('TransactionList', () => {
  it('keeps already-loaded pages when the server refreshes the first page', async () => {
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    vi.mocked(getLaunchTransactions).mockResolvedValue({ items: [transaction({ txHash: '0xbbbbbbbb2', blockNumber: '90' })], nextCursor: null });
    const props = { venues: noVenues, tokenSymbol: 'DELTA', quoteAsset, chainId: 4663, tokenAddress: '0xtoken' };
    const { rerender } = render(<TransactionList {...props} transactions={[transaction()]} nextCursor="cursor-1" />);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(screen.getAllByRole('row')).toHaveLength(3);

    // router.refresh() delivers the same first page as a new array instance.
    rerender(<TransactionList {...props} transactions={[transaction()]} nextCursor="cursor-1" />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    vi.unstubAllGlobals();
  });


  it('shows skeleton rows while the next page loads, then replaces them with the new rows', async () => {
    let resolvePage!: (page: { items: Transaction[]; nextCursor: string | null }) => void;
    vi.mocked(getLaunchTransactions).mockReturnValue(new Promise((resolve) => { resolvePage = resolve; }) as never);
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    render(<TransactionList transactions={[transaction()]} venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset}
      chainId={4663} tokenAddress="0xtoken" nextCursor="cursor-1" />);
    expect(screen.queryAllByTestId('transaction-skeleton-row')).toHaveLength(0);

    act(() => intersect([{ isIntersecting: true }]));
    expect(screen.getAllByTestId('transaction-skeleton-row')).toHaveLength(6);

    await act(async () => resolvePage({ items: [transaction({ txHash: '0xbbbbbbbb2', logIndex: 1 })], nextCursor: null }));
    expect(screen.queryAllByTestId('transaction-skeleton-row')).toHaveLength(0);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    vi.unstubAllGlobals();
  });

  it('filters rows by Buy/Sell from the Type header, with both selected by default', () => {
    render(<TransactionList transactions={[
      transaction({ txHash: '0xaaaaaaaa1', side: 'buy' }),
      transaction({ txHash: '0xbbbbbbbb2', side: 'sell' }),
    ]} venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Filter by type' }));
    expect(screen.queryByRole('button', { name: /^All/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Buy/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Sell/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /^Buy/ }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Buy/ })).toHaveAttribute('aria-pressed', 'false');

    // Deselecting everything is allowed and shows no rows.
    fireEvent.click(screen.getByRole('button', { name: /^Sell/ }));
    expect(screen.getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('No transactions match this filter.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Buy/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Sell/ }));
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('shows a loading state for a pending USD value, keeping the onchain amount visible', () => {
    render(<TransactionList transactions={[transaction({ usdValueStatus: 'pending' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText(/calculating|loading/i)).toBeInTheDocument();
  });

  it('labels a protocol buyback trade as done by Pons', () => {
    render(<TransactionList transactions={[transaction({ activityKind: 'protocol_buyback' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('Buyback by Pons')).toBeInTheDocument();
  });

  it('rounds the token/quote/USD amount columns to 2 decimals, showing <0.01 for a sub-cent amount', () => {
    render(<TransactionList transactions={[transaction({ tokenAmount: '523.1349', quoteAmount: '0.004',
      usdValue: '0.009', usdValueStatus: 'priced', usdValueApprox: true })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('523.13')).toBeInTheDocument();
    expect(screen.getByText('<0.01')).toBeInTheDocument();
    expect(screen.getByText('$<0.01')).toBeInTheDocument();
  });

  it('prefixes a priced USD value with $, without affecting the quote-amount column', () => {
    render(<TransactionList transactions={[transaction({ usdValue: '5.25', usdValueStatus: 'priced' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('$5.25')).toBeInTheDocument();
  });

  it('shows a pool-sourced row like any other swap, with no extra "(pool)" marker', () => {
    render(<TransactionList transactions={[transaction({ source: 'pool', venueId: null,
      pool: { protocol: 'uniswap_v4', poolId: '0xpool' } })]} venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.queryByText('(pool)')).not.toBeInTheDocument();
  });

  it('never shows a protocol activity label for a pool-sourced row, even when activityKind looks like one', () => {
    render(<TransactionList transactions={[transaction({ source: 'pool', venueId: null,
      pool: { protocol: 'uniswap_v4', poolId: '0xpool' }, activityKind: 'protocol_buyback' })]}
      venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.queryByText('Buyback by Pons')).not.toBeInTheDocument();
  });

  it('labels an unattributed internal Pons swap neutrally', () => {
    render(<TransactionList transactions={[transaction({ activityKind: 'protocol_internal' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('Internal Pons transaction')).toBeInTheDocument();
  });

  it('shows an ordinary user trade as a buy/sell side, not a protocol label', () => {
    render(<TransactionList transactions={[transaction({ activityKind: 'user_trade', side: 'buy' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText('Buy')).toBeInTheDocument();
  });

  it('shows the historical USD value for a priced row, with a tooltip explaining it is historical not current', () => {
    render(<TransactionList transactions={[transaction({ usdValue: '5.25', usdValueApprox: true, usdValueStatus: 'priced' })]}
      venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText(/5\.25/)).toBeInTheDocument();
    expect(screen.getByTitle(/historical.*not the current price/i)).toBeInTheDocument();
  });

  it('shows "—" for a row USD value instead of a fabricated number when usdValue is null', () => {
    render(<TransactionList transactions={[transaction({ usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable' })]}
      venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows a truncated wallet address linking to the explorer address page', () => {
    render(<TransactionList transactions={[transaction({ traderAddress: '0x1234567890123456789012345678901234567890' })]}
      venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} explorerBase="https://explorer.example" />);
    const link = screen.getByRole('link', { name: /0x1234[…\.]{1,3}7890/i });
    expect(link).toHaveAttribute('href', 'https://explorer.example/address/0x1234567890123456789012345678901234567890');
  });

  it('shows the truncated transaction hash and links it to the explorer', () => {
    const txHash = '0x1234567890123456789012345678901234567890123456789012345678907890';
    render(<TransactionList transactions={[transaction({ txHash, traderAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} explorerBase="https://explorer.example" />);
    const link = screen.getByRole('link', { name: '0x1234…7890' });
    expect(link).toHaveAttribute('href', `https://explorer.example/tx/${txHash}`);
  });

  describe('Time column', () => {
    const txTimestamp = 1_700_000_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime((txTimestamp + 10) * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a seconds-level relative time, not an absolute date/time', () => {
      render(<TransactionList transactions={[transaction({ timestamp: txTimestamp })]} venues={noVenues}
        tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
      expect(screen.getByLabelText('10s')).toBeInTheDocument();
    });

    it('ticks the relative time forward live as time passes, without a new render call', () => {
      render(<TransactionList transactions={[transaction({ timestamp: txTimestamp })]} venues={noVenues}
        tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
      expect(screen.getByLabelText('10s')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(screen.getByLabelText('15s')).toBeInTheDocument();
      expect(screen.queryByLabelText('10s')).not.toBeInTheDocument();
    });

    it('keeps the exact absolute timestamp available as a tooltip', () => {
      render(<TransactionList transactions={[transaction({ timestamp: txTimestamp })]} venues={noVenues}
        tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
      expect(screen.getByTitle(new Date(txTimestamp * 1000).toLocaleString('en-US'))).toBeInTheDocument();
    });
  });
});
