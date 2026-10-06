import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OfficialVenue, Transaction } from '@/api/client';
import { TransactionList } from './transaction-list';

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
    expect(screen.getAllByText('<0.01').length).toBeGreaterThanOrEqual(1);
  });

  it('labels a pool-sourced row distinctly from an official trade, without implying an official partnership', () => {
    render(<TransactionList transactions={[transaction({ source: 'pool', venueId: null,
      pool: { protocol: 'uniswap_v4', poolId: '0xpool' } })]} venues={noVenues} tokenSymbol="DELTA" quoteAsset={quoteAsset} />);
    expect(screen.getByText(/pool/i)).toBeInTheDocument();
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

  it('still links to the transaction on the explorer', () => {
    render(<TransactionList transactions={[transaction({ txHash: '0xabc' })]} venues={noVenues}
      tokenSymbol="DELTA" quoteAsset={quoteAsset} explorerBase="https://explorer.example" />);
    const link = screen.getByRole('link', { name: 'Tx' });
    expect(link).toHaveAttribute('href', 'https://explorer.example/tx/0xabc');
  });
});
