import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OfficialVenue, Trade } from '@/api/client';
import { TradeList } from './trade-list';

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    venueId: 'pons-v2-curve:0xtoken',
    blockNumber: '100',
    txHash: '0xtx1',
    logIndex: 0,
    timestamp: 1_700_000_000,
    side: 'buy',
    activityKind: 'user_trade',
    tokenAmount: '10',
    quoteAmount: '1',
    priceQuote: '0.1',
    traderAddress: '0xtrader',
    usdValue: null,
    usdValueApprox: false,
    usdValueStatus: 'unavailable',
    ...overrides,
  };
}

const noVenues: readonly OfficialVenue[] = [];

describe('TradeList', () => {
  it('shows a loading state for a pending trade USD value, keeping the onchain amount visible', () => {
    render(<TradeList trades={[trade({ usdValue: null, usdValueApprox: false, usdValueStatus: 'pending' })]} venues={noVenues} quoteSymbol="ROBIN" explorerBase={undefined} />);
    expect(screen.getByText(/calculating|loading/i)).toBeInTheDocument();
    expect(screen.getByText(trade().tokenAmount)).toBeInTheDocument(); // onchain amount still shown
  });

  it('shows the honest unavailable state for usdValueStatus unavailable, distinct from pending', () => {
    render(<TradeList trades={[trade({ usdValue: null, usdValueApprox: false, usdValueStatus: 'unavailable' })]} venues={noVenues} quoteSymbol="ROBIN" explorerBase={undefined} />);
    expect(screen.getByText(/no data yet|unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/calculating|loading/i)).not.toBeInTheDocument();
  });

  it('shows the real historical USD value for a priced trade, labeled as historical not current', () => {
    render(<TradeList trades={[trade({ usdValue: '42.5', usdValueApprox: true, usdValueStatus: 'priced' })]} venues={noVenues} quoteSymbol="ROBIN" explorerBase={undefined} />);
    expect(screen.getByText(/\$42\.5/)).toBeInTheDocument();
    const cell = screen.getByText(/\$42\.5/);
    expect(cell).toHaveAttribute('title', expect.stringMatching(/historical|at trade time/i));
  });
});
