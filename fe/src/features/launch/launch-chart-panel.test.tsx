import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLaunchHistory } from '@/api/client';
import { emitLaunchChanged, emitPoolChanged, emitTradeCreated } from '@/hooks/live-events';
import { LaunchChartPanel } from './launch-chart-panel';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getLaunchHistory: vi.fn() }));

vi.mock('lightweight-charts', () => ({
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  HistogramSeries: {}, AreaSeries: {},
  createChart: () => ({ addSeries: () => ({ setData: vi.fn() }), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ fitContent: vi.fn() }) }),
}));
vi.mock('./official-price-chart', () => ({ OfficialPriceChart: ({ trailing, chartStyle }: { trailing?: React.ReactNode; chartStyle?: string }) => <div data-testid="launch-price-chart" data-style={chartStyle}>{trailing}</div> }));

const price = { priceText: '$1', priceStale: false, candles: null, graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'complete',
  currency: 'quote' as const, tokenSymbol: 'TKN', source: { launch: { chainId: 4663, tokenAddress: '0xabc' } } };
const history = { items: [{ day: 864_000, tradeCount: 1, volumeUsd: '1500', tvlUsd: '40000' }], complete: true };

describe('LaunchChartPanel', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('reloads Volume on the committed trade event without waiting for launch stats', async () => {
    vi.mocked(getLaunchHistory).mockReset();
    vi.mocked(getLaunchHistory).mockResolvedValue({ ...history, items: [{ day: 864_000, tradeCount: 2, volumeUsd: '2000', tvlUsd: '40000' }] });
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    await act(async () => { emitTradeCreated({ chainId: 4663, tokenAddress: '0xabc' }); });
    expect(getLaunchHistory).toHaveBeenCalledWith(4663, '0xabc', '1h', undefined);
  });

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

  it('shows candle-size tabs for candles and 1H 1D 1W 1M 1Y for the line, on Volume too, each style remembering its own tab', async () => {
    vi.mocked(getLaunchHistory).mockResolvedValue({ ...history, intervalSeconds: 300 });
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['1m', '5m', '1H', '4H', '1D']);
    fireEvent.click(screen.getByRole('link', { name: '4H' }));
    await waitFor(() => expect(getLaunchHistory).toHaveBeenLastCalledWith(4663, '0xabc', '4h', undefined));
    fireEvent.click(screen.getByRole('tab', { name: 'Price' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Line chart' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    await waitFor(() => expect(getLaunchHistory).toHaveBeenLastCalledWith(4663, '0xabc', 'w1d', undefined));
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['1H', '1D', '1W', '1M', '1Y']);
    expect(screen.getByRole('link', { name: '1D' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('link', { name: '1W' }));
    await waitFor(() => expect(getLaunchHistory).toHaveBeenLastCalledWith(4663, '0xabc', 'w1w', undefined));
    fireEvent.click(screen.getByRole('tab', { name: 'Price' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Candlestick chart' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    // 4H was loaded earlier, so it comes back from the cache; the tabs show it again.
    await waitFor(() => expect(screen.getByRole('link', { name: '4H' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['1m', '5m', '1H', '4H', '1D']);
  });

  it('hides the line / candles switch on the Volume and TVL charts', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    expect(screen.queryByRole('tab', { name: 'Line chart' })).not.toBeInTheDocument();
  });

  it('leaves the TVL tab out for a token with no pool (still on its bonding curve), keeping Price and Volume', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={{ ...history, poolCount: 0 }} />);
    expect(screen.getByRole('tab', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'TVL' })).not.toBeInTheDocument();
  });

  it('adds Volume and TVL next to Price when the launch has a Volume / TVL history', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={{ ...history, poolCount: 1 }} />);
    expect(screen.getByRole('tab', { name: 'Price' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'TVL' }));
    expect(screen.getByRole('img', { name: /^tvl over/i })).toBeInTheDocument();
  });

  it('tells how many pools had no USD price on the token page', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={{ ...history, unvaluedPools: 2, poolCount: 1 }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
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

  it("reloads Volume and TVL when the launch changes or a swap lands in a pool holding the token, and not for others", async () => {
    vi.mocked(getLaunchHistory).mockReset();
    vi.mocked(getLaunchHistory).mockResolvedValue({ items: [{ day: 864_000, tradeCount: 3, volumeUsd: '4200', tvlUsd: '40000' }], complete: true });
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xAbC" history={history} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    await act(async () => { emitLaunchChanged({ chainId: 4663, tokenAddress: '0xother' }); });
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xpool', poolTokens: ['0xother1', '0xother2'] }); });
    expect(getLaunchHistory).not.toHaveBeenCalled();
    await act(async () => { emitLaunchChanged({ chainId: 4663, tokenAddress: '0xabc' }); });
    expect(getLaunchHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByLabelText('$4.2K')).toBeInTheDocument());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xpool', poolTokens: ['0xabc', '0xother2'] }); });
    expect(getLaunchHistory).toHaveBeenCalledTimes(2);
  });
});
