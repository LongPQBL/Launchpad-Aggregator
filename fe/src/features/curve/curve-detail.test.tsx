import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CandlePage, CurveSummary, LaunchDetail, OfficialVenue, TransactionPage } from '@/api/client';
import { formatPrice } from '@/api/format';
import { CurveDetail } from './curve-detail';

vi.mock('@/features/launch/launch-chart-panel', () => ({
  LaunchChartPanel: ({ venue, history }: { venue?: string; history: unknown }) => <div data-testid="chart-panel" data-venue={venue} data-has-history={String(history !== null)} />,
}));
vi.mock('@/features/launch/transaction-list', () => ({
  TransactionList: ({ venue }: { venue?: string }) => <div data-testid="transaction-list" data-venue={venue} />,
}));
vi.mock('@/trading/curve-swap-panel', () => ({ CurveSwapPanel: () => <div data-testid="curve-swap" /> }));
vi.mock('@/components/sticky-detail-header', () => ({ StickyDetailHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/features/pools/pool-logo', () => ({ PoolLogo: () => <span data-testid="pool-logo" /> }));

const curveVenue: OfficialVenue = { id: 'pons-v2-curve:0xtoken', kind: 'curve', ref: '0xcurve', effectiveFromBlock: '1', effectiveToBlock: null };
const v4Venue: OfficialVenue = { id: 'pons-v2-v4:0xtoken', kind: 'v4_pool', ref: '0xpoolid', effectiveFromBlock: '10', effectiveToBlock: null };

function detail(overrides: Partial<LaunchDetail> = {}): LaunchDetail {
  return {
    chainId: 4663, tokenAddress: '0xtoken', name: 'Token', symbol: 'TKN', platform: 'pons', protocolVersion: 'v2', tokenDecimals: 18,
    quoteAsset: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }, lifecycleStatus: 'trading',
    launchTimestamp: String(Math.floor(Date.now() / 1000) - 7200), logoUri: null, coverageStatus: 'caught_up', quotePriceUsd: null, priceUsd: null,
    officialVenues: [curveVenue], ...overrides,
  } as unknown as LaunchDetail;
}
const summary = (overrides: Partial<CurveSummary> = {}): CurveSummary => ({
  venueId: curveVenue.id, curveAddress: '0xcurve', active: true, volume24hQuote: '12.5', tradeCount24h: 7, lastPriceQuote: '0.002', ...overrides,
});
const emptyTransactions: TransactionPage = { items: [], nextCursor: null };
const candles: CandlePage = { items: [], complete: true };
const history = { items: [], complete: true };

function renderDetail(props: Partial<React.ComponentProps<typeof CurveDetail>> = {}) {
  return render(<CurveDetail detail={detail()} summary={summary()} transactions={emptyTransactions} candles={candles} history={history} chartInterval={3600} {...props} />);
}

describe('CurveDetail', () => {
  it('titles the page as the token / quote pair with a Bonding curve badge and the Pons caption, under a Pools breadcrumb', () => {
    renderDetail();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Pools' })).toHaveAttribute('href', '/pools');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TKN / ETH');
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
    expect(screen.getByText(/Official Pons pool/)).toBeInTheDocument();
  });

  it('scopes the chart and the transaction list to the curve venue', () => {
    renderDetail({ transactions: { items: [{ source: 'official', venueId: curveVenue.id, blockNumber: '1', txHash: '0xtx', logIndex: 0 }] as unknown as TransactionPage['items'], nextCursor: null } });
    expect(screen.getByTestId('chart-panel')).toHaveAttribute('data-venue', 'curve');
    expect(screen.getByTestId('transaction-list')).toHaveAttribute('data-venue', 'curve');
  });

  it('shows the curve-only 24H volume, trade count and last price from the summary', () => {
    renderDetail();
    const stats = screen.getByRole('region', { name: 'Stats' });
    expect(within(stats).getByText('12.5 ETH')).toBeInTheDocument();
    expect(within(stats).getByText('7')).toBeInTheDocument();
    expect(within(stats).getByText(formatPrice('0.002', 'ETH'))).toBeInTheDocument();
  });

  it('shows an em dash, never 0, when the curve has no priced trade yet', () => {
    renderDetail({ summary: summary({ lastPriceQuote: null, tradeCount24h: 0, volume24hQuote: '0' }) });
    const stats = screen.getByRole('region', { name: 'Stats' });
    const price = within(stats).getByText('Current price').nextElementSibling;
    expect(price).toHaveTextContent('—');
  });

  it('offers the curve swap panel while the curve is active', () => {
    renderDetail();
    expect(screen.getByTestId('curve-swap')).toBeInTheDocument();
  });

  it('after graduation has no swap panel and links to the official V4 pool instead', () => {
    renderDetail({ detail: detail({ officialVenues: [{ ...curveVenue, effectiveToBlock: '9' }, v4Venue], lifecycleStatus: 'graduated' }), summary: summary({ active: false }) });
    expect(screen.queryByTestId('curve-swap')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /official v4 pool/i })).toHaveAttribute('href', '/pools/4663/uniswap_v4/0xpoolid?displayedToken=0xtoken');
  });

  it('says there are no transactions yet for a curve without trades', () => {
    renderDetail();
    expect(screen.getByText('No transactions yet')).toBeInTheDocument();
  });

  it('reports a failed transactions load instead of an empty table', () => {
    renderDetail({ transactions: null });
    expect(screen.getByRole('status')).toHaveTextContent('Could not load transactions.');
  });
});
