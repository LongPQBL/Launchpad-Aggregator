import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, LaunchDetail as LaunchDetailData, OfficialVenue, Trade } from '@/api/client';
import { LaunchDetail } from './launch-detail';

const setDataMock = vi.fn();
const applyOptionsMock = vi.fn();
const removeMock = vi.fn();
const setMarkersMock = vi.fn();
const addSeriesMock = vi.fn((..._args: unknown[]) => ({ setData: setDataMock, applyOptions: applyOptionsMock }));
const createSeriesMarkersMock = vi.fn((..._args: unknown[]) => ({ setMarkers: setMarkersMock }));
const createChartMock = vi.fn((..._args: unknown[]) => ({ addSeries: addSeriesMock, remove: removeMock }));

vi.mock('lightweight-charts', () => ({
  createChart: (...args: unknown[]) => createChartMock(...args),
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkersMock(...args),
  CandlestickSeries: 'CandlestickSeries',
}));

beforeEach(() => {
  setDataMock.mockClear();
  applyOptionsMock.mockClear();
  removeMock.mockClear();
  setMarkersMock.mockClear();
  addSeriesMock.mockClear();
  createSeriesMarkersMock.mockClear();
  createChartMock.mockClear();
});

function venue(overrides: Partial<OfficialVenue> = {}): OfficialVenue {
  return {
    id: 'pons-v2-curve:0xtoken',
    kind: 'curve',
    ref: '0xcurve',
    effectiveFromBlock: '100',
    effectiveToBlock: '200',
    ...overrides,
  };
}

function detail(overrides: Partial<LaunchDetailData> = {}): LaunchDetailData {
  return {
    chainId: 4663,
    tokenAddress: '0xabc',
    name: 'Token A',
    symbol: 'TKA',
    platform: 'pons',
    protocolVersion: 'v2',
    quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: 18 },
    lifecycleStatus: 'trading',
    officialVolume24h: '12.5',
    coverageStatus: 'caught_up',
    officialVenues: [venue()],
    priceQuote: '0.0001',
    priceStale: false,
    ...overrides,
  };
}

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
    ...overrides,
  };
}

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    intervalSeconds: 60,
    bucketStart: 1_700_000_000,
    open: '0.1',
    high: '0.2',
    low: '0.05',
    close: '0.15',
    quoteVolume: '5',
    ...overrides,
  };
}

describe('LaunchDetail', () => {
  it('shows source, protocol version, chain, quote asset, and 24h volume', () => {
    render(<LaunchDetail detail={detail()} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);

    expect(screen.getByRole('link', { name: /pons/i })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText(/Robinhood Chain/)).toBeInTheDocument();
    expect(screen.getByText(/Tài sản ghép cặp/)).toHaveTextContent('ROBIN');
    expect(screen.getByText(/12\.5 ROBIN/)).toBeInTheDocument();
  });

  it('shows the swept phase label', () => {
    render(
      <LaunchDetail
        detail={detail({ lifecycleStatus: 'swept' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Swept/)).toBeInTheDocument();
  });

  it('shows the rescued phase label', () => {
    render(
      <LaunchDetail
        detail={detail({ lifecycleStatus: 'rescued' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Rescued/)).toBeInTheDocument();
  });

  it('lists official venues by kind', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve' }), venue({ id: 'pons-v2-v4:0xpool', kind: 'v4_pool' })] })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    const venueSection = screen.getByRole('region', { name: /nơi giao dịch chính thức/i });
    expect(within(venueSection).getByText('Bonding curve')).toBeInTheDocument();
    expect(within(venueSection).getByText('Pool Uniswap V4')).toBeInTheDocument();
  });

  it('updates data on the existing chart instance instead of recreating it on refresh, so the user\'s zoom/pan is not reset', () => {
    const { rerender } = render(
      <LaunchDetail detail={detail()} trades={{ items: [], nextCursor: null }} candles={{ items: [candle()], complete: true }} />,
    );
    expect(createChartMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();

    // Simulate a live-refresh: same component, a freshly-fetched (new-reference) candles array.
    rerender(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [candle({ close: '0.2' })], complete: true }}
      />,
    );

    expect(createChartMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(setDataMock).toHaveBeenCalledTimes(2);
  });

  it('does not synthesize candles across a data gap — the chart receives exactly the candles it was given', () => {
    const candlesWithGap = [candle({ bucketStart: 1_700_000_000 }), candle({ bucketStart: 1_700_010_000 })];
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: candlesWithGap, complete: true }}
      />,
    );

    expect(setDataMock).toHaveBeenCalledTimes(1);
    expect(setDataMock.mock.calls[0]![0]).toHaveLength(2);
  });

  it('sorts candles ascending by time before charting, since the API returns them newest-first', () => {
    // be/src/api/store.ts's listCandles reverses an ascending query into newest-first order.
    // Lightweight Charts requires strictly ascending time and throws (crashing the page) otherwise.
    const newestFirst = [
      candle({ bucketStart: 1_700_000_120, close: '0.3' }),
      candle({ bucketStart: 1_700_000_060, close: '0.2' }),
      candle({ bucketStart: 1_700_000_000, close: '0.1' }),
    ];
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: newestFirst, complete: true }}
      />,
    );

    const charted = setDataMock.mock.calls[0]![0] as { time: number }[];
    expect(charted.map((c) => c.time)).toEqual([1_700_000_000, 1_700_000_060, 1_700_000_120]);
  });

  it('sets a price precision that keeps sub-cent pons-scale prices readable on the chart axis', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [candle({ open: '0.000000152', high: '0.000000160', low: '0.000000140', close: '0.000000155' })], complete: true }}
      />,
    );

    const [lastOptions] = applyOptionsMock.mock.calls.at(-1)!;
    const priceFormat = (lastOptions as { priceFormat: { precision: number; minMove: number } }).priceFormat;
    expect(priceFormat.precision).toBeGreaterThanOrEqual(8);
    expect(priceFormat.minMove).toBeLessThanOrEqual(1e-8);
  });

  it('shows a coverage badge when the launch data is still backfilling', () => {
    render(
      <LaunchDetail
        detail={detail({ coverageStatus: 'backfilling' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    const badges = screen.getAllByTestId('coverage-badge');
    expect(badges.every((badge) => badge.textContent === 'Đang đồng bộ')).toBe(true);
  });

  it('marks the chart as incomplete when the candle window still has unpriced trades, even if the launch is caught up', () => {
    render(
      <LaunchDetail
        detail={detail({ coverageStatus: 'caught_up' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [candle()], complete: false }}
      />,
    );

    const badges = screen.getAllByTestId('coverage-badge');
    expect(badges.some((badge) => badge.textContent === 'Đang đồng bộ')).toBe(true);
  });

  it('places the curve-to-V4 marker at the earliest V4 trade, not the newest, even though the API returns trades newest-first', () => {
    // be/src/api/store.ts's listTrades orders `ORDER BY block_number DESC`: the first V4 trade
    // in the array is the most recent one, not the graduation-adjacent one.
    const v4VenueId = 'pons-v2-v4:0xpool';
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve' }), venue({ id: v4VenueId, kind: 'v4_pool' })] })}
        trades={{
          items: [
            trade({ venueId: v4VenueId, timestamp: 1_700_000_300, txHash: '0xtx3' }),
            trade({ venueId: v4VenueId, timestamp: 1_700_000_200, txHash: '0xtx2' }),
            trade({ venueId: 'pons-v2-curve:0xtoken', timestamp: 1_700_000_100 }),
          ],
          nextCursor: null,
        }}
        candles={{ items: [candle()], complete: true }}
      />,
    );

    expect(setMarkersMock).toHaveBeenCalled();
    const [markers] = setMarkersMock.mock.calls.at(-1)!;
    expect(markers).toEqual([expect.objectContaining({ time: 1_700_000_200 })]);
  });

  it('labels a protocol buyback trade as done by Pons, never as the user\'s own order', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ activityKind: 'protocol_buyback', txHash: '0xbuyback' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('Buyback bởi Pons')).toBeInTheDocument();
  });

  it('labels an unattributed internal Pons swap neutrally', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ activityKind: 'protocol_internal', txHash: '0xinternal' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('Giao dịch nội bộ Pons')).toBeInTheDocument();
  });

  it('shows an ordinary user trade as a buy/sell side, not a protocol label', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ activityKind: 'user_trade', side: 'buy', txHash: '0xuser' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('Mua')).toBeInTheDocument();
  });

  it('shows the current official price', () => {
    render(
      <LaunchDetail
        detail={detail({ priceQuote: '0.000000152480063034', priceStale: false })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/0\.000000152480063034 ROBIN/)).toBeInTheDocument();
  });

  it('labels the price as stale instead of presenting it as the current market price', () => {
    render(
      <LaunchDetail
        detail={detail({ priceQuote: '0.0001', priceStale: true })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/giá cũ/i)).toBeInTheDocument();
  });

  it('shows "Chưa có dữ liệu" for price instead of a fabricated value when the price is not yet available', () => {
    render(
      <LaunchDetail
        detail={detail({ priceQuote: null })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Giá hiện tại/)).toHaveTextContent('Chưa có dữ liệu');
  });

  it('keeps the exact decimal string for a 6-decimal token trade amount, without rounding it', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ tokenAmount: '123.456789', txHash: '0xsixdec' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('123.456789')).toBeInTheDocument();
  });
});
