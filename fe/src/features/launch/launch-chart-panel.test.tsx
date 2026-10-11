import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchChartPanel } from './launch-chart-panel';

vi.mock('lightweight-charts', () => ({
  HistogramSeries: {}, AreaSeries: {},
  createChart: () => ({ addSeries: () => ({ setData: vi.fn() }), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ fitContent: vi.fn() }) }),
}));
vi.mock('./official-price-chart', () => ({ OfficialPriceChart: ({ trailing, chartStyle }: { trailing?: React.ReactNode; chartStyle?: string }) => <div data-testid="launch-price-chart" data-style={chartStyle}>{trailing}</div> }));

const price = { priceText: '$1', priceStale: false, candles: null, graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'complete',
  currency: 'quote' as const, tokenSymbol: 'TKN', source: { launch: { chainId: 4663, tokenAddress: '0xabc' } } };
const history = { items: [{ day: 864_000, tradeCount: 1, volumeUsd: '1500', tvlUsd: '40000' }], complete: true };

describe('LaunchChartPanel', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('offers a line / candles switch beside the Price tabs, defaulting to candles, and remembers the choice', () => {
    const { unmount } = render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    expect(screen.getByRole('tab', { name: 'Candlestick chart' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('launch-price-chart')).toHaveAttribute('data-style', 'candles');
    fireEvent.click(screen.getByRole('tab', { name: 'Line chart' }));
    expect(screen.getByTestId('launch-price-chart')).toHaveAttribute('data-style', 'line');
    expect(window.localStorage.getItem('chartStyle')).toBe('line');
    unmount();
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    expect(screen.getByRole('tab', { name: 'Line chart' })).toHaveAttribute('aria-selected', 'true');
  });

  it('hides the line / candles switch on the Volume and TVL charts', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume · all pools' }));
    expect(screen.queryByRole('tab', { name: 'Line chart' })).not.toBeInTheDocument();
  });

  it('adds Volume and TVL next to Price when the launch has a Volume / TVL history', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    expect(screen.getByRole('tab', { name: 'Price' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'TVL · all pools' }));
    expect(screen.getByRole('img', { name: /^tvl \(all pools\) over/i })).toBeInTheDocument();
  });

  it('says "all pools" on the token page and tells how many pools had no USD price', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={{ ...history, unvaluedPools: 2 }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume · all pools' }));
    expect(screen.getByText('Excludes 2 pools without a USD price.')).toBeInTheDocument();
  });

  it('scoped to the curve it offers Price and Volume but no TVL tab', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} venue="curve" />);
    expect(screen.getByRole('tab', { name: 'Price' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'TVL' })).not.toBeInTheDocument();
  });

  it('shows only the price chart, with no tabs, when the launch has no Volume / TVL history', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={null} />);
    expect(screen.getByTestId('launch-price-chart')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Chart type' })).not.toBeInTheDocument();
  });
});
