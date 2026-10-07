import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, LaunchDetail as LaunchDetailData, OfficialVenue, Transaction } from '@/api/client';
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

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  useBalance: () => ({ data: undefined, isLoading: false }),
  useReadContract: (args: { functionName?: string; address?: string }) => {
    if (args?.functionName === 'allowance' && args?.address?.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3') {
      return { data: undefined, isLoading: false };
    }
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  },
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn(), isPending: false, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle' }),
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
    tokenDecimals: 18,
    lifecycleStatus: 'trading',
    officialVolume24h: '12.5',
    coverageStatus: 'caught_up',
    officialVenues: [venue()],
    priceQuote: '0.0001',
    priceStale: false,
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
      ponsDesignated: false, launchTokenAddress: null, volume24hUsd: null, priceInQuote: null,
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

  it('shows a Next transactions link with the cursor when there is a next page, and hides it when there is none', () => {
    const view = render(<LaunchDetail detail={detail({ chainId: 4663, tokenAddress: '0xabc' })}
      transactions={{ items: [], nextCursor: 'abc123' }} candles={null} />);
    const link = view.container.querySelector('a[href*="cursor="]');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '/launches/4663/0xabc?cursor=abc123');

    view.rerender(<LaunchDetail detail={detail({ chainId: 4663, tokenAddress: '0xabc' })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(view.container.querySelector('a[href*="cursor="]')).toBeNull();
  });

  it('shows a Launches > Symbol breadcrumb', () => {
    render(<LaunchDetail detail={detail({ symbol: 'TKA' })} transactions={null} candles={null} />);

    const breadcrumb = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(breadcrumb).getByRole('link', { name: 'Launches' })).toHaveAttribute('href', '/');
    expect(within(breadcrumb).getByText('TKA')).toBeInTheDocument();
  });

  it('shows token, Robinhood Chain, and Pons brand images in the header, plus the plain token address', () => {
    render(<LaunchDetail detail={detail({ logoUri: 'https://example.com/token.png', tokenAddress: '0xabc0000000000000000000000000000000001e18' })} transactions={null} candles={null} />);

    expect(screen.getByRole('img', { name: 'Token logo' })).toHaveAttribute('src', 'https://example.com/token.png');
    expect(screen.getByRole('img', { name: 'Robinhood Chain' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pons logo' })).toBeInTheDocument();
    // The Description section's copy-address button (fe/src/features/launch/about-section.tsx)
    // renders the same short-address format — scoped by test id to avoid an ambiguous match.
    expect(screen.getByTestId('header-token-address')).toHaveTextContent('0xabc0…1e18');
  });

  it('does not show Robinhood or Pons branding for another source', () => {
    render(<LaunchDetail detail={detail({ chainId: 1, platform: 'other' })} transactions={null} candles={null} />);

    expect(screen.queryByRole('img', { name: 'Robinhood Chain' })).not.toBeInTheDocument();
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
    expect(screen.getByText('Quote asset: —')).toBeInTheDocument();
  });

  it('hides the Description section explorer pill for a chain with no registered explorer', () => {
    render(<LaunchDetail detail={detail({ chainId: 999999 })} transactions={null} candles={null} />);
    expect(screen.queryByRole('link', { name: /explorer/i })).not.toBeInTheDocument();
  });

  it('shows source, protocol version, chain, quote asset, and 24h volume', () => {
    render(<LaunchDetail detail={detail()} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);

    expect(screen.getByRole('link', { name: /pons/i })).toHaveAttribute('href', 'https://docs.ponsfamily.com/');
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    // Scoped to the source line, not a bare substring match — the Description section's explorer pill
    // also renders "Robinhood Chain" (as part of "Robinhood Chain Explorer") and would otherwise
    // make this an ambiguous "found multiple elements" match.
    const sourceLine = screen.getByText(/Source:/).closest('p')!;
    expect(within(sourceLine).getByText(/Robinhood Chain/)).toBeInTheDocument();
    expect(screen.getByText(/Quote asset/)).toHaveTextContent('ROBIN');
    expect(screen.getByText(/12\.5 ROBIN/)).toBeInTheDocument();
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
    expect(within(stats).getByText(/TVL/)).toHaveTextContent('1200.5');
    expect(within(stats).getByText(/Market cap/)).toHaveTextContent('269.2');
    expect(within(stats).getByText(/FDV/)).toHaveTextContent('269.2');
    expect(within(stats).getByText(/1 day volume/)).toHaveTextContent('10.4');
    expect(within(stats).getByText(/52W High/)).toHaveTextContent('0.08');
    expect(within(stats).getByText(/52W Low/)).toHaveTextContent('0.001');
    const statLabels = within(stats).getAllByText(/TVL|Market cap|FDV|1 day volume|52W High|52W Low/)
      .map((el) => el.textContent?.split(':')[0]);
    expect(statLabels).toEqual(['TVL', 'Market cap', 'FDV', '1 day volume', '52W High', '52W Low']);
  });

  it('explains the phase-specific TVL basis and missing quote prices', () => {
    const view = render(<LaunchDetail detail={detail({ tvlUsd: '15.7', tvlBasis: 'curve_real_quote', tvlUnavailableReason: null })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('real quote'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: '42', tvlBasis: 'pool_principal', tvlUnavailableReason: null })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('both tokens'));

    view.rerender(<LaunchDetail detail={detail({ tvlUsd: null, tvlUnavailableReason: 'quote_price_unavailable' })}
      transactions={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByText(/TVL/)).toHaveTextContent('—');
    expect(screen.getByText(/TVL/)).toHaveAttribute('title', expect.stringContaining('USD price'));
  });

  it('shows "—" for FDV instead of a fabricated number when fdvUsd is null', () => {
    render(
      <LaunchDetail detail={detail({ fdvUsd: null })} transactions={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />,
    );
    expect(screen.getByText(/FDV/)).toHaveTextContent('—');
  });

  it('shows the swept phase label', () => {
    render(
      <LaunchDetail
        detail={detail({ lifecycleStatus: 'swept' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Swept/)).toBeInTheDocument();
  });

  it('shows the rescued phase label', () => {
    render(
      <LaunchDetail
        detail={detail({ lifecycleStatus: 'rescued' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    expect(screen.getByText(/Rescued/)).toBeInTheDocument();
  });

  it('lists official venues by kind', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve' }), venue({ id: 'pons-v2-v4:0xpool', kind: 'v4_pool' })] })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );

    const venueSection = screen.getByRole('region', { name: /official trading venues/i });
    expect(within(venueSection).getByText('Bonding curve')).toBeInTheDocument();
    expect(within(venueSection).getByText('Uniswap V4 Pool')).toBeInTheDocument();
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
    const priceFormat = (lastOptions as { priceFormat: { precision: number; minMove: number } }).priceFormat;
    expect(priceFormat.precision).toBeGreaterThanOrEqual(8);
    expect(priceFormat.minMove).toBeLessThanOrEqual(1e-8);
  });

  it('shows a coverage badge when the launch data is still backfilling', () => {
    render(
      <LaunchDetail
        detail={detail({ coverageStatus: 'backfilling' })}
        transactions={{ items: [], nextCursor: null }}
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
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [candle()], complete: false }}
      />,
    );

    const badges = screen.getAllByTestId('coverage-badge');
    expect(badges.some((badge) => badge.textContent === 'Backfilling')).toBe(true);
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
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument();

    rerender(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: '500' }), venue({ id: 'pons-v2-v4:0xpool', kind: 'v4_pool', effectiveToBlock: null })], lifecycleStatus: 'graduated' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
  });

  it('hides the curve trade panel once the curve is swept, even though it is still the latest venue row', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'swept' })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
  });

  it('hides the curve trade panel when tokenDecimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading', tokenDecimals: null })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
  });

  it('hides the curve trade panel when the quote asset decimals has not resolved yet, rather than guessing it', () => {
    render(
      <LaunchDetail
        detail={detail({ officialVenues: [venue({ kind: 'curve', effectiveToBlock: null })], lifecycleStatus: 'trading', quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: null } })}
        transactions={{ items: [], nextCursor: null }}
        candles={{ items: [], complete: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Buy' })).not.toBeInTheDocument();
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
          volume24hUsd: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
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
          volume24hUsd: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
          change1h: null, change1d: null, coverageStatus: 'backfilling', lastTradeTimestamp: null,
        }}
      />,
    );
    expect(screen.getByText(/Sell.*MYTOK/i)).toBeInTheDocument();
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
          volume24hUsd: null, priceInQuote: null, priceUsd: null, fdvUsd: null, tvlUsd: null,
          change1h: null, change1d: null, coverageStatus: 'backfilling', lastTradeTimestamp: null,
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /flip|swap direction/i })).not.toBeInTheDocument();
  });
});
