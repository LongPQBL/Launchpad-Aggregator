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
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  // Any other method call on the chart or series is a no-op; most tests check the markup, not the canvas.
  CandlestickSeries: {}, AreaSeries: {}, createChart: () => chartStub, createSeriesMarkers: () => chartStub,
}));

const props = { candles: [], graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'caught_up' };

describe('OfficialChart range tabs', () => {
  it('loads a new range client-side and updates only the chart data', async () => {
    getLaunchCandlesMock.mockResolvedValueOnce({ items: [{
      intervalSeconds: 3600, bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005', quoteVolume: '1',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ launch: { chainId: 4663, tokenAddress: '0xc9e9ab90654f82893d7fd18b62f694992e8cef29' } }} range="1d" tokenSymbol="E2E" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chart range' })).getByRole('link', { name: '1W' }));

    // The price itself never reaches the DOM — lightweight-charts is mocked to a no-op above, so
    // the refetch firing with the right params is the only observable, non-canvas effect here.
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', {
      currency: 'quote', range: '1w',
    }));
  });

  it('reports a picked range to onSelectRange, and loads candles when a sibling chart moves the shared range', async () => {
    getLaunchCandlesMock.mockResolvedValue({ items: [], complete: true });
    const onSelectRange = vi.fn();
    const source = { launch: { chainId: 4663, tokenAddress: '0xabc' } };
    const { rerender } = render(<OfficialChart {...props} source={source} range="1d" onSelectRange={onSelectRange} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chart range' })).getByRole('link', { name: '1Y' }));
    expect(onSelectRange).toHaveBeenCalledWith('1y');
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenLastCalledWith(4663, '0xabc', { currency: 'quote', range: '1y' }));

    getLaunchCandlesMock.mockClear();
    rerender(<OfficialChart {...props} source={source} range="1h" onSelectRange={onSelectRange} />);
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xabc', { currency: 'quote', range: '1h' }));
    expect(within(screen.getByRole('navigation', { name: 'Chart range' })).getByRole('link', { name: '1H' })).toHaveAttribute('aria-current', 'page');
  });

  it('places range tabs below the chart and hides plotting disclaimer and token price', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} range="1w" currency="usd" tokenSymbol="E2E" />);
    const chart = screen.getByTestId('official-chart-container');
    const intervals = screen.getByRole('navigation', { name: 'Chart range' });

    expect(chart.compareDocumentPosition(intervals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/approximate for plotting/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
    expect(within(intervals).getByRole('link', { name: '1W' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers 1H, 1D, 1W, 1M, 1Y and All, and marks the active one', () => {
    render(<OfficialChart {...props} range="1d" currency="usd" />);
    const nav = screen.getByRole('navigation', { name: 'Chart range' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['1H', '1D', '1W', '1M', '1Y', 'All']);
    expect(nav).toHaveClass('inline-flex', 'flex-wrap');
    expect(within(nav).getByText('1D')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1H')).toHaveAttribute('href', '?currency=usd&range=1h');
  });

  it('does not show a separate latest token price above the chart', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="quote" />);
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
  });

  it('keeps the selected range when switching currency', () => {
    render(<OfficialChart {...props} range="1w" currency="quote" />);
    expect(screen.getByRole('link', { name: 'USD' })).toHaveAttribute('href', '?currency=usd&range=1w');
  });

  it('refetches from getPoolCandles (not getLaunchCandles) when given a pool source', async () => {
    getPoolCandlesMock.mockResolvedValueOnce({ items: [{
      bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ pool: { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' } }}
      range="1d" tokenSymbol="MOCK1" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chart range' })).getByRole('link', { name: '1W' }));

    await waitFor(() => expect(getPoolCandlesMock).toHaveBeenCalledWith(
      { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' }, '1w',
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

  it('shows open, high, low and close of the hovered candle in a tooltip, and removes it on leave', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="quote" />);
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;
    act(() => {
      handler({
        time: 1_699_990_000 as Time, point: { x: 80, y: 90 },
        seriesData: new Map([[chartStub, { time: 1_699_990_000 as Time, open: 0.0005, high: 0.0006, low: 0.0004, close: 0.00055 }]]),
      } as unknown as MouseEventParams<Time>);
    });
    const box = screen.getByTestId('chart-ohlc-tooltip');
    expect(box).toHaveTextContent('Open');
    expect(box).toHaveTextContent('Close');
    act(() => { handler({ seriesData: new Map() } as unknown as MouseEventParams<Time>); });
    expect(screen.queryByTestId('chart-ohlc-tooltip')).toBeNull();
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
