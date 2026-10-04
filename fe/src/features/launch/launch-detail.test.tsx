import { fireEvent, render, screen, within } from '@testing-library/react';
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
    fdvUsd: null,
    marketCapUsd: null,
    tvlUsd: null,
    tvlBasis: null,
    tvlBlockNumber: null,
    tvlPriceSource: null,
    tvlPriceUpdatedAt: null,
    tvlUnavailableReason: 'unavailable',
    week52High: null,
    week52Low: null,
    logoUri: null,
    description: null,
    websiteUrl: null,
    twitterUrl: null,
    launchTimestamp: null,
    change1h: null,
    change1d: null,
    officialVolume24hUsd: null,
    officialVolume24hUsdApprox: false,
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
    traderAddress: '0xtrader',
    usdValue: null,
    usdValueApprox: false,
    usdValueStatus: 'unavailable',
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
  it('shows token, Robinhood Chain, and Pons brand images in the header', () => {
    render(<LaunchDetail detail={detail({ logoUri: 'https://example.com/token.png' })} trades={null} candles={null} />);

    expect(screen.getByRole('img', { name: 'Token logo' })).toHaveAttribute('src', 'https://example.com/token.png');
    expect(screen.getByRole('img', { name: 'Robinhood Chain' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pons logo' })).toBeInTheDocument();
  });

  it('does not show Robinhood or Pons branding for another source', () => {
    render(<LaunchDetail detail={detail({ chainId: 1, platform: 'other' })} trades={null} candles={null} />);

    expect(screen.queryByRole('img', { name: 'Robinhood Chain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Pons logo' })).not.toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('hides the About section explorer pill for a chain with no registered explorer', () => {
    render(<LaunchDetail detail={detail({ chainId: 999999 })} trades={null} candles={null} />);
    expect(screen.queryByRole('link', { name: /explorer/i })).not.toBeInTheDocument();
  });

  it('shows source, protocol version, chain, quote asset, and 24h volume', () => {
    render(<LaunchDetail detail={detail()} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);

    expect(screen.getByRole('link', { name: /pons/i })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText(/Robinhood Chain/)).toBeInTheDocument();
    expect(screen.getByText(/Quote asset/)).toHaveTextContent('ROBIN');
    expect(screen.getByText(/12\.5 ROBIN/)).toBeInTheDocument();
  });

  it('shows FDV, market cap, TVL, and 52-week high/low in the stats grid when available', () => {
    render(
      <LaunchDetail
        detail={detail({ fdvUsd: '269.17', marketCapUsd: '269.17', tvlUsd: '1200.50', week52High: '0.08', week52Low: '0.001' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.getByText(/FDV/)).toHaveTextContent('269.17');
    expect(screen.getByText(/Market cap/)).toHaveTextContent('269.17');
    expect(screen.getByText(/TVL/)).toHaveTextContent('1200.50');
    expect(screen.getByText(/52W High/)).toHaveTextContent('0.08');
    expect(screen.getByText(/52W Low/)).toHaveTextContent('0.001');
  });

  it('explains the phase-specific TVL basis and missing quote prices', () => {
    const view = render(<LaunchDetail detail={detail({ tvlUsd: '15.7', tvlBasis: 'curve_real_quote', tvlUnavailableReason: null })}
      trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('real quote'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: '42', tvlBasis: 'pool_principal', tvlUnavailableReason: null })}
      trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('both tokens'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: null, tvlUnavailableReason: 'quote_price_unavailable' })}
      trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveTextContent('No data yet');
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('USD price'));
  });

  it('shows "No data yet" for FDV instead of a fabricated number when fdvUsd is null', () => {
    render(
      <LaunchDetail detail={detail({ fdvUsd: null })} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );
    expect(screen.getByText(/FDV/)).toHaveTextContent('No data yet');
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

    const venueSection = screen.getByRole('region', { name: /official trading venues/i });
    expect(within(venueSection).getByText('Bonding curve')).toBeInTheDocument();
    expect(within(venueSection).getByText('Uniswap V4 Pool')).toBeInTheDocument();
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
    expect(badges.every((badge) => badge.textContent === 'Backfilling')).toBe(true);
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
    expect(badges.some((badge) => badge.textContent === 'Backfilling')).toBe(true);
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

    expect(screen.getByText('Buyback by Pons')).toBeInTheDocument();
  });

  it('labels an unattributed internal Pons swap neutrally', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ activityKind: 'protocol_internal', txHash: '0xinternal' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('Internal Pons transaction')).toBeInTheDocument();
  });

  it('shows an ordinary user trade as a buy/sell side, not a protocol label', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ activityKind: 'user_trade', side: 'buy', txHash: '0xuser' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText('Buy')).toBeInTheDocument();
  });

  it('shows the historical USD value for a priced trade, with a tooltip explaining it is historical not current', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ usdValue: '5.25', usdValueApprox: true, usdValueStatus: 'priced' })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.getByText(/5\.25/)).toBeInTheDocument();
    expect(screen.getByTitle(/historical.*not the current price/i)).toBeInTheDocument();
  });

  it('shows "No data yet" for a trade USD value instead of a fabricated number when usdValue is null', () => {
    render(
      <LaunchDetail
        detail={detail()}
        trades={{ items: [trade({ usdValue: null, usdValueApprox: false })], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.getAllByText('No data yet').length).toBeGreaterThan(0);
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

    expect(screen.getByText(/stale price/i)).toBeInTheDocument();
  });

  it('shows "No data yet" for price instead of a fabricated value when the price is not yet available', () => {
    render(
      <LaunchDetail
        detail={detail({ priceQuote: null })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Current price/)).toHaveTextContent('No data yet');
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

  it('renders the About section with description, truncated with Show more when long', () => {
    const longDescription = 'A'.repeat(260);
    // jsdom never computes real layout, so the About section's overflow-gated Show more control
    // (fe/src/features/launch/about-section.tsx) needs a mocked scrollHeight/clientHeight to
    // simulate a collapsed paragraph that overflows three lines — see about-section.test.tsx for
    // the full matrix of overflow-detection cases; this test only exercises the integration.
    Object.defineProperty(HTMLParagraphElement.prototype, 'scrollHeight', { configurable: true, get: () => 120 });
    Object.defineProperty(HTMLParagraphElement.prototype, 'clientHeight', { configurable: true, get: () => 60 });
    try {
      render(
        <LaunchDetail
          detail={detail({ description: longDescription })}
          trades={{ items: [], nextCursor: null }}
          candles={{ items: [], complete: true }}
        />,
      );

      const showMore = screen.getByRole('button', { name: /show more/i });
      expect(screen.getByText(longDescription)).toHaveClass('line-clamp-3');
      fireEvent.click(showMore);
      expect(screen.getByText(longDescription)).not.toHaveClass('line-clamp-3');
    } finally {
      // @ts-expect-error -- restoring jsdom's own default descriptor, not a real browser API
      delete HTMLParagraphElement.prototype.scrollHeight;
      // @ts-expect-error -- same as above
      delete HTMLParagraphElement.prototype.clientHeight;
    }
  });

  it('hides the About section description entirely when null', () => {
    render(
      <LaunchDetail detail={detail({ description: null })} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );

    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('always renders the token address and Robinhood Explorer pills', () => {
    render(
      <LaunchDetail detail={detail({ tokenAddress: '0xabc' })} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );

    const explorerLink = screen.getByRole('link', { name: /robinhood explorer/i });
    expect(explorerLink).toHaveAttribute('href', 'https://robinhoodchain.blockscout.com/token/0xabc');
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('hides the Website pill when websiteUrl is null, and the Twitter pill when twitterUrl is null', () => {
    render(
      <LaunchDetail
        detail={detail({ websiteUrl: null, twitterUrl: 'https://x.com/example' })}
        trades={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.queryByRole('link', { name: /website/i })).not.toBeInTheDocument();
    const twitterLink = screen.getByRole('link', { name: /twitter/i });
    expect(twitterLink).toHaveAttribute('href', 'https://x.com/example');
  });
});
