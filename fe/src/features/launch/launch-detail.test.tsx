import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, LaunchDetail as LaunchDetailData, OfficialVenue, Transaction } from '@/api/client';
import { LaunchDetail } from './launch-detail';

const setDataMock = vi.fn();
const applyOptionsMock = vi.fn();
const removeMock = vi.fn();
const setMarkersMock = vi.fn();
const createPriceLineMock = vi.fn();
const removePriceLineMock = vi.fn();
const subscribeCrosshairMoveMock = vi.fn();
const unsubscribeCrosshairMoveMock = vi.fn();
const addSeriesMock = vi.fn((..._args: unknown[]) => ({
  setData: setDataMock,
  applyOptions: applyOptionsMock,
  createPriceLine: createPriceLineMock,
  removePriceLine: removePriceLineMock,
}));
const createSeriesMarkersMock = vi.fn((..._args: unknown[]) => ({ setMarkers: setMarkersMock }));
const createChartMock = vi.fn((..._args: unknown[]) => ({
  addSeries: addSeriesMock,
  remove: removeMock,
  subscribeCrosshairMove: subscribeCrosshairMoveMock,
  unsubscribeCrosshairMove: unsubscribeCrosshairMoveMock,
}));

vi.mock('lightweight-charts', () => ({
  createChart: (...args: unknown[]) => createChartMock(...args),
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkersMock(...args),
  CandlestickSeries: 'CandlestickSeries',
}));

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  useBalance: () => ({ data: undefined, isLoading: false }),
  usePublicClient: () => ({}),
  useReadContract: (args: { functionName?: string; address?: string }) => {
    if (args?.functionName === 'allowance' && args?.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: undefined, isLoading: false };
    }
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
  useSendCalls: () => ({ sendCalls: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForCallsStatus: () => ({ data: undefined, error: null }),
  useCapabilities: () => ({ data: undefined }),
}));

beforeEach(() => {
  setDataMock.mockClear();
  applyOptionsMock.mockClear();
  removeMock.mockClear();
  setMarkersMock.mockClear();
  createPriceLineMock.mockClear();
  removePriceLineMock.mockClear();
  addSeriesMock.mockClear();
  createSeriesMarkersMock.mockClear();
  createChartMock.mockClear();
  subscribeCrosshairMoveMock.mockClear();
  unsubscribeCrosshairMoveMock.mockClear();
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
    tokenDecimals: 18,
    lifecycleStatus: 'trading',
    officialVolume24h: '12.5',
    coverageStatus: 'caught_up',
    officialVenues: [venue()],
    priceQuote: '0.0001',
    priceStale: false,
    quotePriceUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    priceUsd: null,
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
    officialVolume24hUsdAsOf: null,
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    source: 'official',
    venueId: 'pons-v2-curve:0xtoken',
    pool: null,
    blockNumber: '100',
    txHash: '0xtx1',
    logIndex: 0,
    timestamp: 1_700_000_000,
    side: 'buy',
    activityKind: 'user_trade',
    tokenAmount: '10',
    quoteAmount: '1',
    quoteAssetAddress: '0xquote',
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
  it('shows other pools under the Pools tab and shows empty-state content when pools are unavailable', () => {
    const otherPool = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'b'.repeat(64)}`,
      currency0: '0x1111111111111111111111111111111111111111', currency1: '0x2222222222222222222222222222222222222222',
      displayedToken: '0x1111111111111111111111111111111111111111', fee: 3000, tickSpacing: 60,
      currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
      currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
      hooks: '0x0000000000000000000000000000000000000000', createdBlock: '123', createdTimestamp: null,
      ponsDesignated: false, launchTokenAddress: null, volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null,
      poolBalances: null,
      priceUsd: null, fdvUsd: null, tvlUsd: null, change1h: null, change1d: null,
      coverageStatus: 'backfilling', lastTradeTimestamp: null };
    const view = render(<LaunchDetail detail={detail()} transactions={null} candles={null}
      pools={{ items: [otherPool], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(view.container.querySelector(`a[href^="/pools/4663/uniswap_v4/0x${'b'.repeat(64)}"]`)).not.toBeNull();
    view.rerender(<LaunchDetail detail={detail()} transactions={null} candles={null} pools={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(screen.getByText('Could not load pools.')).toBeInTheDocument();
  });

  it('shows the transaction load-more sentinel when there is a next page, and hides it when there is none', () => {
    const view = render(<LaunchDetail detail={detail({ chainId: 4663, tokenAddress: '0xabc' })}
      transactions={{ items: [], nextCursor: 'abc123' }} candles={null} />);
    expect(view.getByTestId('transactions-load-more-sentinel')).toBeInTheDocument();

    view.rerender(<LaunchDetail detail={detail({ chainId: 4663, tokenAddress: '0xabc' })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(view.queryByTestId('transactions-load-more-sentinel')).not.toBeInTheDocument();
  });

  it('shows an X icon link in the header when twitterUrl is set, and a Share button always', () => {
    render(<LaunchDetail detail={detail({ twitterUrl: 'https://x.com/example' })} transactions={null} candles={null} />);
    expect(screen.getByRole('link', { name: 'X' })).toHaveAttribute('href', 'https://x.com/example');
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('hides the header X icon link when twitterUrl is null', () => {
    render(<LaunchDetail detail={detail({ twitterUrl: null })} transactions={null} candles={null} />);
    expect(screen.queryByRole('link', { name: 'X' })).not.toBeInTheDocument();
  });

  it('shows a Launches > Symbol breadcrumb', () => {
    render(<LaunchDetail detail={detail({ symbol: 'TKA' })} transactions={null} candles={null} />);

    const breadcrumb = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(breadcrumb).getByRole('link', { name: 'Launches' })).toHaveAttribute('href', '/launches');
    expect(within(breadcrumb).getByText('TKA')).toBeInTheDocument();
  });

  it('shows token, Robinhood Chain, and Pons brand images in the header, plus the plain token address', () => {
    render(<LaunchDetail detail={detail({ logoUri: 'https://example.com/token.png', tokenAddress: '0xabc0000000000000000000000000000000001e18' })} transactions={null} candles={null} />);

    expect(screen.getByRole('img', { name: 'Token logo' })).toHaveAttribute('src', 'https://example.com/token.png');
    // The Robinhood Chain badge is decorative (aria-hidden, same treatment as its sibling
    // letter-fallback span) — it has no accessible name/role, so it's queried by its raw `alt`
    // attribute instead of role+name.
    expect(screen.getByAltText('Robinhood Chain')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pons logo' })).toBeInTheDocument();
    // The Description section's copy-address button (fe/src/features/launch/about-section.tsx)
    // renders the same short-address format — scoped by test id to avoid an ambiguous match.
    expect(screen.getByTestId('header-token-address')).toHaveTextContent('0xabc0…1e18');
  });

  it('copies the full token address from the header and keeps the address visible', async () => {
    const tokenAddress = '0xabc0000000000000000000000000000000001e18';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<LaunchDetail detail={detail({ tokenAddress })} transactions={null} candles={null} />);

    const address = screen.getByRole('group', { name: 'Token address' });
    fireEvent.click(within(address).getByTestId('header-token-address'));

    expect(writeText).toHaveBeenCalledWith(tokenAddress);
    expect(await within(address).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByTestId('header-token-address')).toHaveTextContent('0xabc0…1e18');
  });

  it('does not show Robinhood or Pons branding for another source', () => {
    render(<LaunchDetail detail={detail({ chainId: 1, platform: 'other' })} transactions={null} candles={null} />);

    expect(screen.queryByAltText('Robinhood Chain')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Pons logo' })).not.toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('shows the token address as the name and a dash for symbol/quote asset while core metadata is pending', () => {
    render(
      <LaunchDetail
        detail={detail({ name: null, symbol: null, quoteAsset: { address: '0xquote', symbol: null, decimals: null } })}
        transactions={null}
        candles={null}
      />,
    );
    expect(screen.getByRole('heading', { name: /0xabc/ })).toBeInTheDocument();
    expect(screen.queryByText(/Quote asset:/)).not.toBeInTheDocument();
  });

  it('hides the Description section explorer pill for a chain with no registered explorer', () => {
    render(<LaunchDetail detail={detail({ chainId: 999999 })} transactions={null} candles={null} />);
    expect(screen.queryByRole('link', { name: /explorer/i })).not.toBeInTheDocument();
  });

  it('shows launchpad, protocol version and chain without a quote asset or header volume line', () => {
    render(<LaunchDetail detail={detail()} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);

    expect(screen.getByRole('link', { name: /pons/i })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    const launchpadLine = screen.getByRole('link', { name: /pons/i }).closest('p')!;
    expect(within(launchpadLine).getByText(/Robinhood Chain/)).toBeInTheDocument();
    expect(screen.queryByText(/Quote asset/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12\.5 ROBIN/)).not.toBeInTheDocument();
  });

  it('shows a Stats heading with TVL, market cap, FDV, 1 day volume (USD), and 52-week high/low, in that order', () => {
    render(
      <LaunchDetail
        detail={detail({ fdvUsd: '269.17', marketCapUsd: '269.17', tvlUsd: '1200.50', week52High: '0.08', week52Low: '0.001',
          officialVolume24hUsd: '10.4' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    const stats = screen.getByRole('region', { name: 'Stats' });
    expect(within(stats).getByRole('heading', { name: 'Stats' })).toBeInTheDocument();
    const terms = within(stats).getAllByRole('term');
    const definitions = within(stats).getAllByRole('definition');
    expect(terms.map((term) => term.textContent)).toEqual(['TVL', 'Market cap', 'FDV', '1 day volume', '52W High', '52W Low']);
    expect(terms[0]).toHaveClass('text-sm');
    expect(definitions[0]).toHaveClass('text-2xl');
    expect(definitions.map((definition) => definition.textContent)).toEqual(['$1.2K', '$269.2', '$269.2', '$10.4', '0.0800 ROBIN', '0.00100 ROBIN']);
    const statLabels = terms.map((el) => el.textContent);
    expect(statLabels).toEqual(['TVL', 'Market cap', 'FDV', '1 day volume', '52W High', '52W Low']);
  });

  it('explains the phase-specific TVL basis and missing quote prices', () => {
    const view = render(<LaunchDetail detail={detail({ tvlUsd: '15.7', tvlBasis: 'curve_real_quote', tvlUnavailableReason: null })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText('TVL').closest('div')).toHaveAttribute('title', expect.stringContaining('real quote'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: '42', tvlBasis: 'pool_principal', tvlUnavailableReason: null })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText('TVL').closest('div')).toHaveAttribute('title', expect.stringContaining('both tokens'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: null, tvlUnavailableReason: 'quote_price_unavailable' })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    const tvlRow = screen.getByText('TVL').closest('div')!;
    expect(tvlRow).toHaveTextContent('—');
    expect(tvlRow).toHaveAttribute('title', expect.stringContaining('USD price'));
  });

  it('shows "—" for FDV instead of a fabricated number when fdvUsd is null', () => {
    render(
      <LaunchDetail detail={detail({ fdvUsd: null })} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );
    expect(screen.getByText('FDV').closest('div')).toHaveTextContent('—');
  });

  it('shows no lifecycle status pill or official-venue card in the header area', () => {
    render(
      <LaunchDetail
        detail={detail({ lifecycleStatus: 'swept', officialVenues: [venue({ kind: 'curve' })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.queryByText(/^Swept$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /official trading venues/i })).not.toBeInTheDocument();
  });

  it('updates data on the existing chart instance instead of recreating it on refresh, so the user\'s zoom/pan is not reset', () => {
    const { rerender } = render(
      <LaunchDetail detail={detail()} transactions={{ items: [], nextCursor: null }} candles={{ items: [candle()], complete: true }} />,
    );
    expect(createChartMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();

    // Simulate a live-refresh: same component, a freshly-fetched (new-reference) candles array.
    rerender(
      <LaunchDetail
        detail={detail()}
        transactions={{ items: [], nextCursor: null }}
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
        transactions={{ items: [], nextCursor: null }}
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
        transactions={{ items: [], nextCursor: null }}
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
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [candle({ open: '0.000000152', high: '0.000000160', low: '0.000000140', close: '0.000000155' })], complete: true }}
      />,
    );

    const [lastOptions] = applyOptionsMock.mock.calls.at(-1)!;
    const priceFormat = (lastOptions as { priceFormat: { minMove: number; formatter: (value: number) => string } }).priceFormat;
    expect(priceFormat.minMove).toBeLessThanOrEqual(1e-8);
    // The 'custom' price format type has no separate precision field — the formatter itself must
    // keep sub-cent pons-scale prices readable instead of rounding them away to "0.000000000".
    expect(priceFormat.formatter(0.000000152)).toBe('0.000000152');
  });

  it('hides the coverage badge when the launch data is backfilling', () => {
    render(
      <LaunchDetail
        detail={detail({ coverageStatus: 'backfilling' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.queryByText('Backfilling')).not.toBeInTheDocument();
  });

  it('marks the chart as incomplete when the candle window still has unpriced trades, even if the launch is caught up', () => {
    render(
      <LaunchDetail
        detail={detail({ coverageStatus: 'caught_up' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [candle()], complete: false }}
      />,
    );

    expect(screen.queryByText('Backfilling')).not.toBeInTheDocument();
  });

  it('places the curve-to-V4 marker at the earliest V4 trade, not the newest, even though the API returns transactions newest-first', () => {
    // be/src/api/store.ts's listTransactions orders `ORDER BY block_number DESC`: the first V4
    // row in the array is the most recent one, not the graduation-adjacent one.
    const v4VenueId = 'pons-v2-v4:0xpool';
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve' }), venue({ id: v4VenueId, kind: 'v4_pool' })] })}
        transactions={{
          items: [
            transaction({ venueId: v4VenueId, timestamp: 1_700_000_300, txHash: '0xtx3' }),
            transaction({ venueId: v4VenueId, timestamp: 1_700_000_200, txHash: '0xtx2' }),
            transaction({ venueId: 'pons-v2-curve:0xtoken', timestamp: 1_700_000_100 }),
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

  it('shows the big headline price in USD above the chart when priceUsd is available', () => {
    render(
      <LaunchDetail
        detail={detail({ priceUsd: '0.113', priceQuote: '0.000000152480063034', priceStale: false })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByTestId('official-price')).toHaveTextContent('$0.11');
    expect(screen.getByTestId('official-price')).toHaveClass('text-2xl');
  });

  it('swaps the headline price for the hovered chart point, then reverts to the default price on mouse leave', () => {
    render(
      <LaunchDetail
        detail={detail({ priceUsd: '0.113', priceQuote: '0.000000152480063034', priceStale: false })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [candle({ close: '0.000000155' })], complete: true }}
      />,
    );
    const series = addSeriesMock.mock.results.at(-1)!.value as { applyOptions: unknown };
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: { time?: number; seriesData: Map<unknown, unknown> }) => void;

    act(() => {
      handler({ time: 1_700_000_300, seriesData: new Map([[series, { time: 1_700_000_300, close: 0.000000160 }]]) });
    });
    expect(screen.getByTestId('official-price')).toHaveTextContent('0.000000160 ROBIN');

    act(() => { handler({ seriesData: new Map() }); });
    expect(screen.getByTestId('official-price')).toHaveTextContent('$0.11');
  });

  it('falls back to the quote-denominated price above the chart when priceUsd is unavailable', () => {
    render(
      <LaunchDetail
        detail={detail({ priceUsd: null, priceQuote: '0.000000152480063034', priceStale: false })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByTestId('official-price')).toHaveTextContent('0.000000152 ROBIN');
  });

  it('labels the price as stale instead of presenting it as the current market price', () => {
    render(
      <LaunchDetail
        detail={detail({ priceQuote: '0.0001', priceStale: true })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/stale price/i)).toBeInTheDocument();
  });

  it('shows "—" for price instead of a fabricated value when neither priceUsd nor priceQuote is yet available', () => {
    render(
      <LaunchDetail
        detail={detail({ priceUsd: null, priceQuote: null })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByTestId('official-price')).toHaveTextContent('—');
  });

  it('renders a Description heading (not About)', () => {
    render(<LaunchDetail detail={detail()} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);

    expect(screen.getByRole('heading', { name: 'Description' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
  });

  it('renders the Description section with description, truncated with Show more when long', () => {
    const longDescription = 'A'.repeat(260);
    // jsdom never computes real layout, so the Description section's overflow-gated Show more control
    // (fe/src/features/launch/about-section.tsx) needs a mocked scrollHeight/clientHeight to
    // simulate a collapsed paragraph that overflows three lines — see about-section.test.tsx for
    // the full matrix of overflow-detection cases; this test only exercises the integration.
    Object.defineProperty(HTMLParagraphElement.prototype, 'scrollHeight', { configurable: true, get: () => 120 });
    Object.defineProperty(HTMLParagraphElement.prototype, 'clientHeight', { configurable: true, get: () => 60 });
    try {
      render(
        <LaunchDetail
          detail={detail({ description: longDescription })}
          transactions={{ items: [], nextCursor: null }}
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

  it('hides the Description section description entirely when null', () => {
    render(
      <LaunchDetail detail={detail({ description: null })} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );

    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('always renders the token address and a chain-named explorer pill', () => {
    render(
      <LaunchDetail detail={detail({ tokenAddress: '0xabc' })} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );

    const explorerLink = screen.getByRole('link', { name: /robinhood chain explorer/i });
    expect(explorerLink).toHaveAttribute('href', 'https://robinhoodchain.blockscout.com/token/0xabc');
    expect(screen.getByRole('button', { name: 'Copy token address' })).toBeInTheDocument();
  });

  it('hides the Website pill when websiteUrl is null, and the Twitter pill when twitterUrl is null', () => {
    render(
      <LaunchDetail
        detail={detail({ websiteUrl: null, twitterUrl: 'https://x.com/example' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.queryByRole('link', { name: /website/i })).not.toBeInTheDocument();
    const twitterLink = screen.getByRole('link', { name: /twitter/i });
    expect(twitterLink).toHaveAttribute('href', 'https://x.com/example');
  });

  it('shows the curve trade panel only when the curve is the current venue and the launch is trading', () => {
    const { rerender } = render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.getAllByText('Bonding curve').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Sell amount')).toBeInTheDocument();

    rerender(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: '500' }), venue({ id: 'pons-v2-v4:0xpool', kind: 'v4_pool', effectiveToBlock: null })], lifecycleStatus: 'graduated' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByLabelText('Sell amount')).not.toBeInTheDocument();
  });

  it('hides the curve trade panel once the curve is swept, even though it is still the latest venue row', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'swept' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByLabelText('Sell amount')).not.toBeInTheDocument();
  });

  it('hides the curve trade panel when tokenDecimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading', tokenDecimals: null })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByLabelText('Sell amount')).not.toBeInTheDocument();
  });

  it('hides the curve trade panel when the quote asset decimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading', quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: null } })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByLabelText('Sell amount')).not.toBeInTheDocument();
  });

  describe('curve swap panel USD lines', () => {
    const curveDetail = (quotePriceUsd: string | null) => detail({
      tokenAddress: '0x1111111111111111111111111111111111111111',
      quoteAsset: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
      officialVenues: [venue({ kind: 'curve', effectiveToBlock: null, ref: '0x2222222222222222222222222222222222222222' })],
      lifecycleStatus: 'trading', priceUsd: '2', quotePriceUsd,
    });
    const renderCurve = (quotePriceUsd: string | null) => render(
      <LaunchDetail detail={curveDetail(quotePriceUsd)} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );

    it('shows the quote-side USD value from quotePriceUsd', () => {
      renderCurve('3000');
      fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '0.001' } });
      expect(screen.getByText('$3.00')).toBeInTheDocument();
    });

    it('shows the launched-token USD value from priceUsd after flipping', () => {
      renderCurve('3000');
      fireEvent.click(screen.getByLabelText('Flip swap direction'));
      fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '3' } });
      expect(screen.getByText('$6.00')).toBeInTheDocument();
    });

    it('hides the quote-side USD line when quotePriceUsd is null but keeps the launched-token one', () => {
      renderCurve(null);
      fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '0.001' } });
      expect(screen.queryByText('$3.00')).not.toBeInTheDocument();
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Flip swap direction'));
      fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '3' } });
      expect(screen.getByText('$6.00')).toBeInTheDocument();
    });
  });

  it('shows the V3 swap panel for a V1 launch whose V3 pool venue is currently active', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.getByRole('button', { name: /flip|swap direction/i })).toBeInTheDocument();
  });

  it('hides the V3 swap panel once that venue is no longer active', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: '500' })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });

  it('hides the V3 swap panel when tokenDecimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })], tokenDecimals: null })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });

  it('hides the V3 swap panel when the quote asset decimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v1', officialVenues: [venue({ kind: 'v3_pool', effectiveToBlock: null })], quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: null } })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });

  it('shows the V4 swap panel for a V2 launch whose V4 pool venue is currently active and whose pool data resolved', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v2', lifecycleStatus: 'graduated', officialVenues: [venue({ kind: 'v4_pool', effectiveToBlock: null })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
        v4Pool={{
          chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'c'.repeat(64)}`,
          currency0: '0x1111111111111111111111111111111111111111', currency1: '0x2222222222222222222222222222222222222222',
          displayedToken: '0x1111111111111111111111111111111111111111', fee: 0, tickSpacing: 200,
          currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
          currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
          hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', createdBlock: '123', createdTimestamp: null,
          ponsDesignated: true, launchTokenAddress: '0x1111111111111111111111111111111111111111',
          volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
          poolBalances: null,
          change1h: null, change1d: null, coverageStatus: 'backfilling', lastTradeTimestamp: null,
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /flip|swap direction/i })).toBeInTheDocument();
  });

  it('defaults the V4 swap panel to selling the launch token even when it is currency1, not currency0', () => {
    const tokenAddress = '0x9999999999999999999999999999999999999999';
    render(
      <LaunchDetail
        detail={detail({
          protocolVersion: 'v2', lifecycleStatus: 'graduated', tokenAddress, symbol: 'MYTOK',
          officialVenues: [venue({ kind: 'v4_pool', effectiveToBlock: null })],
        })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
        v4Pool={{
          chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'c'.repeat(64)}`,
          // currency0 is numerically smaller than tokenAddress, so the launch's own token lands
          // on currency1 here — the panel must still default to selling it, not the quote asset.
          currency0: '0x1111111111111111111111111111111111111111', currency1: tokenAddress,
          displayedToken: tokenAddress, fee: 0, tickSpacing: 200,
          currency0Symbol: 'ROBIN', currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
          currency1Symbol: 'MYTOK', currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
          hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', createdBlock: '123', createdTimestamp: null,
          ponsDesignated: true, launchTokenAddress: tokenAddress,
          volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
          poolBalances: null,
          change1h: null, change1d: null, coverageStatus: 'backfilling', lastTradeTimestamp: null,
        }}
      />,
    );
    // Scope to the Sell card's own token pill, so this fails if the default direction regresses
    // (the quote asset ROBIN would then sit in the Sell card instead).
    const sellCard = within(screen.getByText('Sell').parentElement as HTMLElement);
    expect(sellCard.getByRole('button', { name: /MYTOK/ })).toBeInTheDocument();
    expect(sellCard.queryByRole('button', { name: /ROBIN/ })).not.toBeInTheDocument();
  });

  it('hides the V4 swap panel when the venue is active but its pool data did not resolve', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v2', lifecycleStatus: 'graduated', officialVenues: [venue({ kind: 'v4_pool', effectiveToBlock: null })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
        v4Pool={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });

  it('hides the V4 swap panel once that venue is no longer active, even with resolved pool data', () => {
    render(
      <LaunchDetail
        detail={detail({ protocolVersion: 'v2', lifecycleStatus: 'graduated', officialVenues: [venue({ kind: 'v4_pool', effectiveToBlock: '500' })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
        v4Pool={{
          chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'c'.repeat(64)}`,
          currency0: '0x1111111111111111111111111111111111111111', currency1: '0x2222222222222222222222222222222222222222',
          displayedToken: '0x1111111111111111111111111111111111111111', fee: 0, tickSpacing: 200,
          currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
          currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
          hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', createdBlock: '123', createdTimestamp: null,
          ponsDesignated: true, launchTokenAddress: '0x1111111111111111111111111111111111111111',
          volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
          poolBalances: null,
          change1h: null, change1d: null, coverageStatus: 'backfilling', lastTradeTimestamp: null,
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });
});
