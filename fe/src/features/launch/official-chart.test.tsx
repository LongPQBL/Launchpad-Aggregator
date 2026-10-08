import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficialChart } from './official-chart';
import type { MouseEventParams, Time } from 'lightweight-charts';

const { getLaunchCandlesMock, getPoolCandlesMock } = vi.hoisted(() => ({
  getLaunchCandlesMock: vi.fn(), getPoolCandlesMock: vi.fn(),
}));

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getLaunchCandles: getLaunchCandlesMock,
  getPoolCandles: getPoolCandlesMock,
}));

// `chartStub` doubles as both the chart and the series returned from `addSeries` (the `apply`
// trap always returns the same object) so a test can use it as the exact Map key `seriesData`
// is keyed by, and `subscribeCrosshairMoveMock` lets a test fire a simulated hover.
const { subscribeCrosshairMoveMock, chartStub } = vi.hoisted(() => {
  const subscribeCrosshairMoveMock = vi.fn();
  const chartStub: unknown = new Proxy(() => chartStub, {
    get: (_target, prop) => (prop === 'subscribeCrosshairMove' ? subscribeCrosshairMoveMock : chartStub),
    apply: () => chartStub,
  });
  return { subscribeCrosshairMoveMock, chartStub };
});

vi.mock('lightweight-charts', () => ({
  // Any other method call on the chart or series is a no-op; most tests check the markup, not the canvas.
  CandlestickSeries: {}, createChart: () => chartStub, createSeriesMarkers: () => chartStub,
}));

const props = { candles: [], graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'caught_up' };

describe('OfficialChart interval tabs', () => {
  it('loads a new interval client-side and updates only the chart data', async () => {
    getLaunchCandlesMock.mockResolvedValueOnce({ items: [{
      intervalSeconds: 300, bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005', quoteVolume: '1',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ launch: { chainId: 4663, tokenAddress: '0xc9e9ab90654f82893d7fd18b62f694992e8cef29' } }} intervalSeconds={60} tokenSymbol="E2E" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chart interval' })).getByRole('link', { name: '5m' }));

    // The price itself never reaches the DOM — lightweight-charts is mocked to a no-op above, so
    // the refetch firing with the right params is the only observable, non-canvas effect here.
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', {
      currency: 'quote', intervalSeconds: 300,
    }));
  });

  it('places interval tabs below the chart and hides plotting disclaimer and token price', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} intervalSeconds={300} currency="usd" tokenSymbol="E2E" />);
    const chart = screen.getByTestId('official-chart-container');
    const intervals = screen.getByRole('navigation', { name: 'Chart interval' });

    expect(chart.compareDocumentPosition(intervals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/approximate for plotting/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
    expect(within(intervals).getByRole('link', { name: '5m' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers 1m, 5m, 15m, 1h, and 1D, and marks the active one', () => {
    render(<OfficialChart {...props} intervalSeconds={3600} currency="usd" />);
    const nav = screen.getByRole('navigation', { name: 'Chart interval' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['1m', '5m', '15m', '1h', '1D']);
    expect(nav).toHaveClass('inline-flex', 'flex-wrap');
    expect(within(nav).getByText('1h')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1m')).toHaveAttribute('href', '?currency=usd&interval=60');
  });

  it('does not show a separate latest token price above the chart', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="quote" />);
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
  });

  it('keeps the selected interval when switching currency', () => {
    render(<OfficialChart {...props} intervalSeconds={300} currency="quote" />);
    expect(screen.getByRole('link', { name: 'USD' })).toHaveAttribute('href', '?currency=usd&interval=300');
  });

  it('refetches from getPoolCandles (not getLaunchCandles) when given a pool source', async () => {
    getPoolCandlesMock.mockResolvedValueOnce({ items: [{
      bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ pool: { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' } }}
      intervalSeconds={60} tokenSymbol="MOCK1" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chart interval' })).getByRole('link', { name: '5m' }));

    await waitFor(() => expect(getPoolCandlesMock).toHaveBeenCalledWith(
      { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' }, 300,
    ));
    expect(getLaunchCandlesMock).not.toHaveBeenCalled();
  });

  it('hides the quote/USD currency toggle when showCurrencyToggle is false', () => {
    render(<OfficialChart {...props} showCurrencyToggle={false} />);
    expect(screen.queryByRole('navigation', { name: 'Chart currency' })).not.toBeInTheDocument();
  });

  it('reports the hovered point to onHoverPoint, then null on mouse leave', () => {
    const onHoverPoint = vi.fn();
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="quote" onHoverPoint={onHoverPoint} />);
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;

    act(() => {
      handler({
        time: 1_699_990_000 as Time,
        seriesData: new Map([[chartStub, { time: 1_699_990_000 as Time, open: 0.0005, high: 0.0006, low: 0.0004, close: 0.00055 }]]),
      } as unknown as MouseEventParams<Time>);
    });
    expect(onHoverPoint).toHaveBeenLastCalledWith({ time: 1_699_990_000, close: 0.00055, currency: 'quote' });

    act(() => { handler({ seriesData: new Map() } as unknown as MouseEventParams<Time>); });
    expect(onHoverPoint).toHaveBeenLastCalledWith(null);
  });

  it('reports which currency the hovered point is in', () => {
    const onHoverPoint = vi.fn();
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="usd" onHoverPoint={onHoverPoint} />);
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;

    act(() => {
      handler({
        time: 1_699_990_000 as Time,
        seriesData: new Map([[chartStub, { time: 1_699_990_000 as Time, open: 0.5, high: 0.6, low: 0.4, close: 0.55 }]]),
      } as unknown as MouseEventParams<Time>);
    });
    expect(onHoverPoint).toHaveBeenLastCalledWith({ time: 1_699_990_000, close: 0.55, currency: 'usd' });
  });
});
