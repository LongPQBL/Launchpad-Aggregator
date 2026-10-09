import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getLaunchPools, getPools, type PoolSummary } from '@/api/client';
import { PoolList } from './pool-list';
import { PoolDetail } from './pool-detail';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({}),
  useBalance: () => ({ data: undefined, isLoading: false }),
  useReadContract: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
  useSendCalls: () => ({ sendCalls: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForCallsStatus: () => ({ data: undefined, error: null }),
  useCapabilities: () => ({ data: undefined }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
}));

const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const pool: PoolSummary = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'a'.repeat(64)}`,
  currency0: a, currency1: b, displayedToken: a, fee: 3000, tickSpacing: 60,
  currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
  currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
  hooks: '0x0000000000000000000000000000000000000000', createdBlock: '123', createdTimestamp: null,
  ponsDesignated: true, launchTokenAddress: b, volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null,
  poolBalances: null,
  priceUsd: null, fdvUsd: null, tvlUsd: null, change1h: null, change1d: null,
  coverageStatus: 'backfilling', lastTradeTimestamp: null };

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getPools: vi.fn(),
  getLaunchPools: vi.fn(),
}));

// `chartStub` doubles as both the chart and the series returned from `addSeries` (the `apply`
// trap always returns the same object) so a test can use it as the exact Map key `seriesData`
// is keyed by, and `subscribeCrosshairMoveMock` lets a test fire a simulated hover. Mirrors
// official-chart.test.tsx's own mock.
const { subscribeCrosshairMoveMock, chartStub } = vi.hoisted(() => {
  const subscribeCrosshairMoveMock = vi.fn();
  const chartStub: unknown = new Proxy(() => chartStub, {
    get: (_target, prop) => (prop === 'subscribeCrosshairMove' ? subscribeCrosshairMoveMock : chartStub),
    apply: () => chartStub,
  });
  return { subscribeCrosshairMoveMock, chartStub };
});

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, createChart: () => chartStub, createSeriesMarkers: () => chartStub,
}));

describe('Pools UI', () => {
  it('shows skeleton rows in the token pools table while the next page loads', async () => {
    let onIntersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { onIntersect = callback; }
      observe() {}
      disconnect() {}
    });
    let resolvePage!: (page: Awaited<ReturnType<typeof getLaunchPools>>) => void;
    vi.mocked(getLaunchPools).mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
    render(<PoolList page={{ items: [pool], nextCursor: 'cursor-2', supportedProtocols: ['uniswap_v4'] }} tokenAddress={b} chainId={4663} />);
    expect(screen.queryAllByTestId('pool-skeleton-row')).toHaveLength(0);

    await act(async () => {
      onIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(screen.getAllByTestId('pool-skeleton-row')).toHaveLength(6);

    await act(async () => resolvePage({ items: [{ ...pool, poolId: `0x${'b'.repeat(64)}` }], nextCursor: null, supportedProtocols: ['uniswap_v4'] }));
    expect(screen.queryAllByTestId('pool-skeleton-row')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('appends the next pool batch when the list end enters view', async () => {
    let onIntersect: IntersectionObserverCallback | undefined;
    class ObserverMock {
      constructor(callback: IntersectionObserverCallback) { onIntersect = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', ObserverMock);
    const nextPool = { ...pool, poolId: `0x${'b'.repeat(64)}` };
    vi.mocked(getPools).mockResolvedValueOnce({ items: [nextPool], nextCursor: null, supportedProtocols: ['uniswap_v4'] });
    render(<PoolList page={{ items: [pool], nextCursor: 'cursor-2', supportedProtocols: ['uniswap_v4'] }} chainId={4663} />);
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument();

    await act(async () => {
      onIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(getPools).toHaveBeenCalledWith({ cursor: 'cursor-2', chainId: 4663 });
    expect(screen.getAllByRole('link', { name: /0x1111/ })).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('defaults to currency0 globally and preserves Pons side in token scoped links', () => {
    const page = { items: [pool], nextCursor: null, supportedProtocols: ['uniswap_v4'] };
    const { rerender } = render(<PoolList page={page} />);
    const global = screen.getByRole('link', { name: /0x1111.*0x2222/ });
    expect(global).toHaveAttribute('href', expect.stringContaining(`displayedToken=${a}`));
    rerender(<PoolList page={page} tokenAddress={b} />);
    const scoped = screen.getByRole('link', { name: /0x1111.*0x2222/ });
    expect(scoped).toHaveAttribute('href', expect.stringContaining(`displayedToken=${b}`));
    expect(screen.getByText(/Pons designated/)).toBeInTheDocument();
  });
  it('shows missing metrics, coverage and both side switches without APR', () => {
    render(<PoolDetail pool={pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    const flipLink = screen.getByRole('link', { name: 'Flip token order' });
    expect(flipLink).toHaveAttribute('href', expect.stringContaining(`displayedToken=${b}`));
    expect(within(screen.getByText('FDV').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('backfilling')).not.toBeInTheDocument();
    expect(screen.queryByText(/APR/i)).not.toBeInTheDocument();
  });
  it('shows 30D volume and 1D Vol/TVL columns instead of the 1H/1D price changes, with an em dash for unknown values', () => {
    const known: PoolSummary = { ...pool, volume30dUsd: '1200000', volume24hUsd: '300000', tvlUsd: '100000' };
    const unknown: PoolSummary = { ...pool, poolId: `0x${'c'.repeat(64)}`, volume30dUsd: null, volume24hUsd: '5', tvlUsd: null };
    render(<PoolList page={{ items: [known, unknown], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} />);
    expect(screen.getByRole('columnheader', { name: /30D volume/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /1D Vol\/TVL/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^1H$/ })).not.toBeInTheDocument();
    const [, knownRow, unknownRow] = screen.getAllByRole('row');
    expect(within(knownRow!).getByText('$1.2M')).toBeInTheDocument();
    expect(within(knownRow!).getByText('3.00')).toBeInTheDocument();
    expect(within(unknownRow!).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
  it('shows a protocol/fee badge and real token symbols/logos when the API resolved them', () => {
    const resolved: PoolSummary = { ...pool, currency0Symbol: 'GUY', currency0LogoUri: 'https://example.com/guy.png',
      currency1Symbol: 'ETH', currency1LogoUri: 'https://example.com/eth.png' };
    render(<PoolList page={{ items: [resolved], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} />);
    // The global list uses the same table as a token's Pools tab (each row is one link covering the row).
    expect(screen.getByRole('link', { name: 'View pool GUY / ETH' })).toBeInTheDocument();
    expect(screen.getByText(/v4 · 0\.3%/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /token logo/i })).toHaveLength(2);
  });
  it('prefers the embedding launch\'s own known symbol/logo for its side even when the API metadata is null', () => {
    render(<PoolList page={{ items: [pool], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} tokenAddress={a}
      displayedToken={{ address: a, symbol: 'GUY', logoUri: 'https://example.com/guy.png' }} />);
    expect(screen.getByRole('link', { name: /GUY.*0x2222/ })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /token logo/i })).toHaveLength(1);
  });
  it('PoolDetail shows a protocol/fee badge and real symbols when the API resolved them', () => {
    const resolved: PoolSummary = { ...pool, currency0Symbol: 'GUY', currency1Symbol: 'ETH' };
    render(<PoolDetail pool={resolved} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByRole('heading', { name: /GUY \/ ETH/ })).toBeInTheDocument();
    expect(screen.getByText('v4', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(screen.getByText('0.3%', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
  });
  it('PoolDetail shows the 24H volume change vs the previous 24h, and hides it when unavailable', () => {
    const { unmount } = render(<PoolDetail pool={{ ...pool, volume24hUsd: '323000', volume24hChange: '-62.38' }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByTestId('volume-24h-change').textContent).toContain('62.38%');
    expect(screen.getByTestId('volume-24h-change').textContent).toContain('▼');
    unmount();
    render(<PoolDetail pool={{ ...pool, volume24hChange: null }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByTestId('volume-24h-change')).toBeNull();
  });
  it('PoolDetail labels the volume change "New" for a pool younger than 24h, and nothing for an older pool or when volume is unavailable', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { unmount } = render(<PoolDetail pool={{ ...pool, volume24hUsd: '1200', volume24hChange: null, createdTimestamp: nowSeconds - 3600 }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByTestId('volume-24h-change').textContent).toBe('New');
    unmount();
    const older = render(<PoolDetail pool={{ ...pool, volume24hUsd: '1200', volume24hChange: null, createdTimestamp: nowSeconds - 3 * 86400 }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByTestId('volume-24h-change')).toBeNull();
    older.unmount();
    render(<PoolDetail pool={{ ...pool, volume24hUsd: null, volume24hChange: null, createdTimestamp: nowSeconds - 3600 }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByTestId('volume-24h-change')).toBeNull();
  });
  it('PoolDetail shows the TVL change vs 24h ago, and hides it when unavailable', () => {
    const { unmount } = render(<PoolDetail pool={{ ...pool, tvlUsd: '886100', tvlChange: '-13.38' }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByTestId('tvl-change').textContent).toContain('13.38%');
    expect(screen.getByTestId('tvl-change').textContent).toContain('▼');
    unmount();
    render(<PoolDetail pool={{ ...pool, tvlChange: null }} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByTestId('tvl-change')).toBeNull();
  });
  it('PoolDetail shows a V4 Swap panel for a V4 pool once both currencies\' decimals are known', () => {
    const v4Pool: PoolSummary = { ...pool, protocol: 'uniswap_v4' };
    render(<PoolDetail pool={v4Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByLabelText('Flip swap direction')).toBeInTheDocument();
  });
  it('PoolDetail hides the V4 Swap panel when a currency\'s decimals are unknown, rather than guessing', () => {
    const v4Pool: PoolSummary = { ...pool, protocol: 'uniswap_v4', currency1Decimals: null };
    render(<PoolDetail pool={v4Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByLabelText('Flip swap direction')).not.toBeInTheDocument();
  });
  it('PoolDetail hides the V4 Swap panel when the other currency\'s decimals are unknown, rather than guessing', () => {
    const v4Pool: PoolSummary = { ...pool, protocol: 'uniswap_v4', currency0Decimals: null };
    render(<PoolDetail pool={v4Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByLabelText('Flip swap direction')).not.toBeInTheDocument();
  });
  it('PoolDetail shows a Swap panel for a V3 pool once both currencies\' decimals are known', () => {
    const v3Pool: PoolSummary = { ...pool, protocol: 'uniswap_v3' };
    render(<PoolDetail pool={v3Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByLabelText('Flip swap direction')).toBeInTheDocument();
  });
  it('PoolDetail hides the Swap panel for a V3 pool when a currency\'s decimals are unknown, rather than guessing', () => {
    const v3Pool: PoolSummary = { ...pool, protocol: 'uniswap_v3', currency1Decimals: null };
    render(<PoolDetail pool={v3Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByLabelText('Flip swap direction')).not.toBeInTheDocument();
  });
  it('shows the price-ratio header with a USD reading when the quote side has a verified USD feed', () => {
    const priced: PoolSummary = { ...pool, currency0Symbol: 'CASHCAT', currency1Symbol: 'ETH', priceInQuote: '0.044714', priceUsd: '0.119' };
    render(<PoolDetail pool={priced} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);
    expect(screen.getByText((_, node) => node?.textContent === '1 CASHCAT = 0.0447 ETH ($0.1)')).toBeInTheDocument();
  });
  it('omits USD from the price-ratio header when priceUsd is unavailable, e.g. after flipping to a quote with no verified feed', () => {
    const flipped: PoolSummary = { ...pool, currency0Symbol: 'CASHCAT', currency1Symbol: 'ETH', priceInQuote: '21211.57', priceUsd: null };
    render(<PoolDetail pool={flipped} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);
    expect(screen.getByText((_, node) => node?.textContent === '1 CASHCAT = 21211.57 ETH')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });
  it('swaps the price-ratio header for the hovered chart point, dropping USD, then reverts on mouse leave', () => {
    const priced: PoolSummary = { ...pool, currency0Symbol: 'CASHCAT', currency1Symbol: 'ETH', priceInQuote: '0.044714', priceUsd: '0.119' };
    render(<PoolDetail pool={priced} trades={{ items: [], nextCursor: null }} candles={{ items: [], complete: true }} />);
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: { time?: number; seriesData: Map<unknown, unknown> }) => void;

    act(() => {
      handler({ time: 1_700_000_300, seriesData: new Map([[chartStub, { time: 1_700_000_300, close: 0.05 }]]) });
    });
    // Local-time formatting, so derive the expected stamp instead of hardcoding one timezone.
    const stamp = new Date(1_700_000_300 * 1000).toLocaleString('en-US');
    expect(screen.getByText((_, node) => node?.tagName === 'P' && (node.textContent ?? '').startsWith('1 CASHCAT = 0.0500 ETH')
      && (node.textContent ?? '').endsWith(`· ${stamp}`) && !(node.textContent ?? '').includes('$'))).toBeInTheDocument();

    act(() => { handler({ seriesData: new Map() }); });
    expect(screen.getByText((_, node) => node?.textContent === '1 CASHCAT = 0.0447 ETH ($0.1)')).toBeInTheDocument();
  });
});
