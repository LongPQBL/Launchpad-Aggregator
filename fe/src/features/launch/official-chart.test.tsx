import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficialChart } from './official-chart';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { emitLaunchChanged, emitPoolChanged, emitTradeCreated } from '@/hooks/live-events';

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

describe('OfficialChart candle-size tabs', () => {
  it('loads a new range client-side and updates only the chart data', async () => {
    getLaunchCandlesMock.mockResolvedValueOnce({ items: [{
      intervalSeconds: 3600, bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005', quoteVolume: '1',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ launch: { chainId: 4663, tokenAddress: '0xc9e9ab90654f82893d7fd18b62f694992e8cef29' } }} range="5m" tokenSymbol="E2E" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Candle size' })).getByRole('link', { name: '4H' }));

    // The price itself never reaches the DOM — lightweight-charts is mocked to a no-op above, so
    // the refetch firing with the right params is the only observable, non-canvas effect here.
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xc9e9ab90654f82893d7fd18b62f694992e8cef29', {
      currency: 'quote', range: '4h',
    }));
  });

  it('reports a picked range to onSelectRange, and loads candles when a sibling chart moves the shared range', async () => {
    getLaunchCandlesMock.mockResolvedValue({ items: [], complete: true });
    const onSelectRange = vi.fn();
    const source = { launch: { chainId: 4663, tokenAddress: '0xabc' } };
    const { rerender } = render(<OfficialChart {...props} source={source} range="5m" onSelectRange={onSelectRange} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Candle size' })).getByRole('link', { name: '1D' }));
    expect(onSelectRange).toHaveBeenCalledWith('1d');
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenLastCalledWith(4663, '0xabc', { currency: 'quote', range: '1d' }));

    getLaunchCandlesMock.mockClear();
    rerender(<OfficialChart {...props} source={source} range="1h" onSelectRange={onSelectRange} />);
    await waitFor(() => expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xabc', { currency: 'quote', range: '1h' }));
    expect(within(screen.getByRole('navigation', { name: 'Candle size' })).getByRole('link', { name: '1H' })).toHaveAttribute('aria-current', 'page');
  });

  it('places range tabs below the chart and hides plotting disclaimer and token price', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} range="4h" currency="usd" tokenSymbol="E2E" />);
    const chart = screen.getByTestId('official-chart-container');
    const intervals = screen.getByRole('navigation', { name: 'Candle size' });

    expect(chart.compareDocumentPosition(intervals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/approximate for plotting/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
    expect(within(intervals).getByRole('link', { name: '4H' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers 1m, 5m, 1H, 4H and 1D (the size of one candle), and marks the active one', () => {
    render(<OfficialChart {...props} range="1h" currency="usd" />);
    const nav = screen.getByRole('navigation', { name: 'Candle size' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['1m', '5m', '1H', '4H', '1D']);
    expect(nav).toHaveClass('inline-flex', 'flex-wrap');
    expect(within(nav).getByText('1H')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1D')).toHaveAttribute('href', '?currency=usd&range=1d');
  });

  it('offers 1H, 1D, 1W, 1M and 1Y (a span of time) for the line chart, and marks the active one', () => {
    render(<OfficialChart {...props} chartStyle="line" range="w1d" currency="usd" />);
    const nav = screen.getByRole('navigation', { name: 'Time range' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['1H', '1D', '1W', '1M', '1Y']);
    expect(within(nav).getByText('1D')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1W')).toHaveAttribute('href', '?currency=usd&range=w1w');
  });

  it('does not show a separate latest token price above the chart', () => {
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} currency="quote" />);
    expect(screen.queryByTestId('chart-token-price')).not.toBeInTheDocument();
  });

  it('keeps the selected range when switching currency', () => {
    render(<OfficialChart {...props} range="4h" currency="quote" />);
    expect(screen.getByRole('link', { name: 'USD' })).toHaveAttribute('href', '?currency=usd&range=4h');
  });

  it('refetches from getPoolCandles (not getLaunchCandles) when given a pool source', async () => {
    getPoolCandlesMock.mockResolvedValueOnce({ items: [{
      bucketStart: 1_700_000_300, open: '0.0005', high: '0.0006', low: '0.0004', close: '0.0005',
    }], complete: true });
    render(<OfficialChart {...props} candles={[{
      bucketStart: 1_700_000_000, open: '0.00012', high: '0.00014', low: '0.00011', close: '0.00013',
    }]} source={{ pool: { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' } }}
      range="5m" tokenSymbol="MOCK1" />);

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Candle size' })).getByRole('link', { name: '4H' }));

    await waitFor(() => expect(getPoolCandlesMock).toHaveBeenCalledWith(
      { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken' }, '4h',
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

describe('OfficialChart live candles', () => {
  it('reloads the latest launch candle directly after a trade is committed', async () => {
    getLaunchCandlesMock.mockReset();
    getLaunchCandlesMock.mockResolvedValue({ items: [], complete: true });
    render(<OfficialChart {...props} source={{ launch: { chainId: 4663, tokenAddress: '0xAbC' } }} range="4h" />);
    await act(async () => { emitTradeCreated({ chainId: 4663, tokenAddress: '0xabc' }); });
    expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xAbC', { currency: 'quote', range: '4h', venue: undefined });
  });
  it("reloads the candles for the range on screen when its launch's figures change, and ignores another launch", async () => {
    getLaunchCandlesMock.mockReset();
    getLaunchCandlesMock.mockResolvedValue({ items: [], complete: true });
    render(<OfficialChart {...props} source={{ launch: { chainId: 4663, tokenAddress: '0xAbC' } }} range="4h" />);
    await act(async () => { emitLaunchChanged({ chainId: 4663, tokenAddress: '0xother' }); });
    expect(getLaunchCandlesMock).not.toHaveBeenCalled();
    await act(async () => { emitLaunchChanged({ chainId: 4663, tokenAddress: '0xabc' }); });
    expect(getLaunchCandlesMock).toHaveBeenCalledWith(4663, '0xAbC', { currency: 'quote', range: '4h', venue: undefined });
  });

  it('reloads a pool chart when a swap lands in that pool only', async () => {
    getPoolCandlesMock.mockReset();
    getPoolCandlesMock.mockResolvedValue({ items: [], complete: true });
    const poolId = `0x${'ab'.repeat(32)}`;
    render(<OfficialChart {...props} source={{ pool: { chainId: 4663, protocol: 'uniswap_v4', poolId, displayedToken: '0x1' } }} range="5m" />);
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: `0x${'cd'.repeat(32)}` }); });
    expect(getPoolCandlesMock).not.toHaveBeenCalled();
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId }); });
    expect(getPoolCandlesMock).toHaveBeenCalledTimes(1);
  });
});

