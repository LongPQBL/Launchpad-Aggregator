import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLaunches, type LaunchSummary, type Source } from '@/api/client';
import { LaunchList } from './launch-list';

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getLaunches: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

function launch(overrides: Partial<LaunchSummary> = {}): LaunchSummary {
  return {
    chainId: 4663,
    tokenAddress: '0xaaa',
    name: 'Token A',
    symbol: 'TKA',
    platform: 'pons',
    protocolVersion: 'v2',
    quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: 18 },
    tokenDecimals: 18,
    lifecycleStatus: 'trading',
    officialVolume24h: '12.5',
    coverageStatus: 'caught_up',
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

const oneChainOneSource: readonly Source[] = [
  { id: 'pons-v2', chainId: 4663, platform: 'pons', protocolVersion: 'v2' },
  { id: 'pons-v1-active', chainId: 4663, platform: 'pons', protocolVersion: 'v1' },
];

const twoChainsTwoPlatforms: readonly Source[] = [
  { id: 'pons-v2', chainId: 4663, platform: 'pons', protocolVersion: 'v2' },
  { id: 'other-launchpad', chainId: 1, platform: 'other', protocolVersion: 'v1' },
];

describe('LaunchList', () => {
  it('appends the next launch batch when the list end enters view and keeps the active filters', async () => {
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
    vi.mocked(getLaunches).mockResolvedValueOnce({ items: [launch({ tokenAddress: '0xnext', name: 'Token B' })], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false}
      chainId={4663} search="demo" status="swept" platform="pons" tab="recent" />);
    await act(async () => {
      onIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(getLaunches).toHaveBeenCalledWith({ cursor: 'cursor-2', chainId: [4663], search: 'demo', status: 'swept', platform: ['pons'], sort: 'recent' });
    expect(screen.getByRole('link', { name: /view token b details/i })).toBeInTheDocument();
  });

  it('shows the Pons icon only for Pons launch rows', () => {
    render(
      <LaunchList
        page={{ items: [launch(), launch({ tokenAddress: '0xother', platform: 'other', chainId: 1 })], nextCursor: null }}
        sources={twoChainsTwoPlatforms}
        error={false}
      />,
    );

    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByRole('img', { name: 'Pons logo' })).toHaveAttribute(
      'src',
      expect.stringContaining('/images/launchpads/pons.webp'),
    );
    expect(within(rows[1]).queryByRole('img', { name: 'Pons logo' })).not.toBeInTheDocument();
  });

  it('shows the token address as the name and a dash for the symbol while core metadata is pending', () => {
    render(
      <LaunchList
        page={{ items: [launch({ name: null, symbol: null, quoteAsset: { address: '0xquote', symbol: null, decimals: null } })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('0xaaa')).toBeInTheDocument();
    expect(within(row).getByTestId('token-symbol')).toHaveTextContent('—');
  });

  it('shows a human-readable chain name instead of raw enum/id values', () => {
    render(
      <LaunchList
        page={{ items: [launch({ lifecycleStatus: 'swept', chainId: 4663 })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByAltText('Robinhood Chain')).toBeInTheDocument();
    expect(within(table).queryByText('trading')).not.toBeInTheDocument();
  });

  it('renders each launch as a row linking to its detail page', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const table = screen.getByRole('table', { name: /launch list/i });
    const row = within(table).getByRole('link', { name: /Token A/i });
    expect(row).toHaveAttribute('href', '/launches/4663/0xaaa');
  });

  it('gives the same token address on two different chains two different links', () => {
    render(
      <LaunchList
        page={{
          items: [
            launch({ chainId: 4663, tokenAddress: '0xshared', name: 'On Robinhood' }),
            launch({ chainId: 1, tokenAddress: '0xshared', name: 'On Other Chain' }),
          ],
          nextCursor: null,
        }}
        sources={twoChainsTwoPlatforms}
        error={false}
      />,
    );

    const robinhoodLink = screen.getByRole('link', { name: /On Robinhood/i });
    const otherLink = screen.getByRole('link', { name: /On Other Chain/i });
    expect(robinhoodLink).toHaveAttribute('href', '/launches/4663/0xshared');
    expect(otherLink).toHaveAttribute('href', '/launches/1/0xshared');
  });

  it('renders launches in the order given, without re-sorting client-side', () => {
    render(
      <LaunchList
        page={{ items: [launch({ tokenAddress: '0x1', name: 'Newest' }), launch({ tokenAddress: '0x2', name: 'Older' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    const names = screen.getAllByRole('link', { name: /Newest|Older/i }).map((link) => link.getAttribute('aria-label'));
    expect(names[0]).toContain('Newest');
    expect(names[1]).toContain('Older');
  });

  it('shows "—" when officialVolume24h is null instead of a fabricated zero', () => {
    render(
      <LaunchList
        page={{ items: [launch({ officialVolume24h: null })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\b0(\.0+)?\s*ROBIN\b/)).not.toBeInTheDocument();
  });

  it('shows the FDV in USD when available', () => {
    render(
      <LaunchList
        page={{ items: [launch({ fdvUsd: '269.17' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByText(/\$269\.2/)).toBeInTheDocument();
  });

  it('shows TVL in the list, under the Liquidity column, with the correct phase explanation', () => {
    render(<LaunchList page={{ items: [launch({ tvlUsd: '15.7', tvlBasis: 'curve_real_quote', tvlUnavailableReason: null })], nextCursor: null }}
      sources={oneChainOneSource} error={false} />);
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByRole('columnheader', { name: 'Liquidity' })).toBeInTheDocument();
    expect(within(table).getByText('$15.7')).toHaveAttribute('title', expect.stringContaining('real quote'));
  });

  it('renders FDV, 24H volume, Liquidity, 1H%, 1D%, and Age columns with real values', () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86_400;
    render(
      <LaunchList
        page={{
          items: [launch({
            fdvUsd: '1000', officialVolume24h: '50', tvlUsd: '200',
            change1h: '12.5', change1d: '-5', launchTimestamp: String(twoDaysAgo),
          })],
          nextCursor: null,
        }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByRole('columnheader', { name: 'FDV' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '24H volume' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Liquidity' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '1H' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '1D' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Age' })).toBeInTheDocument();
    expect(within(table).getByText('$1000.0')).toBeInTheDocument();
    expect(within(table).getAllByText((_, el) => el?.textContent === '▲12.50%').length).toBeGreaterThan(0);
    expect(within(table).getAllByText((_, el) => el?.textContent === '▼5.00%').length).toBeGreaterThan(0);
    expect(within(table).getByText('2d')).toBeInTheDocument();
  });

  it('renders a dash for null 1H/1D change instead of 0% or blank', () => {
    render(
      <LaunchList
        page={{ items: [launch({ change1h: null, change1d: null })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(table).queryByText('0%')).not.toBeInTheDocument();
  });

  it('shows a visible label next to each metric value for mobile layouts', () => {
    render(
      <LaunchList
        page={{ items: [launch({ fdvUsd: '1000', officialVolume24h: '50', tvlUsd: '200', change1h: '12.5', change1d: '-5' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    const row = within(table).getAllByRole('row')[1];
    expect(within(row).getByText('FDV')).toBeInTheDocument();
    expect(within(row).getByText('24H volume')).toBeInTheDocument();
    expect(within(row).getByText('Liquidity')).toBeInTheDocument();
    expect(within(row).getByText('1H')).toBeInTheDocument();
    expect(within(row).getByText('1D')).toBeInTheDocument();
    expect(within(row).getByText('Age')).toBeInTheDocument();
  });

  it('falls back to a placeholder avatar when logoUri is null', () => {
    render(
      <LaunchList
        page={{ items: [launch({ logoUri: null, symbol: 'TKA' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).queryByRole('img', { name: /token logo/i })).not.toBeInTheDocument();
    expect(within(table).getByText('T')).toBeInTheDocument();
  });

  it('hides the row-specific logo image and shows the placeholder when the image fails to load', () => {
    render(
      <LaunchList
        page={{ items: [launch({ logoUri: 'ipfs://bafkreitest', symbol: 'TKA' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    const img = within(table).getByRole('img', { name: /token logo/i });
    fireEvent.error(img);
    expect(within(table).queryByRole('img', { name: /token logo/i })).not.toBeInTheDocument();
    expect(within(table).getByText('T')).toBeInTheDocument();
  });

  it('always shows the chain filter, even with a single indexed chain (it doubles as the chain switcher)', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    expect(screen.getByRole('navigation', { name: /filter by chain/i })).toBeInTheDocument();
  });

  it('shows the chain filter when sources span more than one chain', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    expect(screen.getByRole('navigation', { name: /filter by chain/i })).toBeInTheDocument();
  });

  it('renders roadmap launchpads alongside the connected source', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const nav = screen.getByRole('navigation', { name: /filter by launchpad/i });
    expect(within(nav).getByRole('button', { name: /pons/i })).toBeInTheDocument();
    for (const name of ['full.fun', 'Bow', 'NOXA', 'Bankr', 'pools.xyz', 'letscash.fun', 'Long', 'Varo']) {
      expect(within(nav).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows each roadmap launchpad logo in the filter', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const nav = screen.getByRole('navigation', { name: /filter by launchpad/i });
    const logos = [
      ['Pons', 'pons.webp'], ['full.fun', 'full-fun.svg'], ['Bow', 'bow.png'],
      ['NOXA', 'noxa.jpeg'], ['Bankr', 'bankr.jpeg'], ['pools.xyz', 'pools-xyz.svg'],
      ['letscash.fun', 'letscash-fun.png'], ['Long', 'long.webp'], ['Varo', 'varo.jpg'],
    ] as const;
    for (const [name, filename] of logos) {
      expect(within(nav).getByRole('button', { name: new RegExp(name.replace('.', '\\.'), 'i') }).querySelector('img')).toHaveAttribute(
        'src', expect.stringContaining(`/images/launchpads/${filename}`),
      );
    }
  });

  it('shows each roadmap chain logo in the filter', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const nav = screen.getByRole('navigation', { name: /filter by chain/i });
    const logos = [
      ['Robinhood Chain', 'robinhood-chain.png'], ['Base', 'base.png'],
      ['Arbitrum', 'arbitrum.png'], ['Arc', 'arc.jpeg'], ['MegaETH', 'megaeth.webp'],
      ['Monad', 'monad.png'], ['Intuition', 'intuition.jpg'], ['Stable', 'stable.png'],
      ['Merlin', 'merlin.webp'], ['BNB Smart Chain', 'bnb-smart-chain.png'],
    ] as const;
    for (const [name, filename] of logos) {
      expect(within(nav).getByRole('button', { name: new RegExp(name, 'i') }).querySelector('img')).toHaveAttribute(
        'src', `/images/chains/${filename}`,
      );
    }
  });

  it('lists every distinct platform from sources in the Launchpad filter, deduped', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    const nav = screen.getByRole('navigation', { name: /filter by launchpad/i });
    expect(within(nav).getAllByRole('button')).toHaveLength(11); // "All launchpads" + nine roadmap entries + other
    expect(within(nav).getByRole('button', { name: /other/i })).toBeInTheDocument();
  });

  it('lists roadmap chains and explains an empty result for a future chain and launchpad', async () => {
    vi.mocked(getLaunches).mockResolvedValue({ items: [], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const chainFilter = screen.getByRole('navigation', { name: /filter by chain/i });
    for (const name of ['Base', 'Arbitrum', 'Arc', 'MegaETH', 'Monad', 'Intuition', 'Stable', 'Merlin', 'BNB Smart Chain']) {
      expect(within(chainFilter).getByRole('button', { name: new RegExp(name, 'i') })).toBeInTheDocument();
    }
    fireEvent.click(within(chainFilter).getByRole('button', { name: 'Arc' }));
    expect(getLaunches).toHaveBeenCalledWith(expect.objectContaining({ chainId: [5042] }));
    expect(await screen.findByText(/no launches match/i)).toBeInTheDocument();
  });

  it('does not show a next-page link when more launches are available for automatic loading', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false} />);
    expect(screen.queryByRole('link', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('shows exactly two tabs: All and Recently launched', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
    expect(within(tabs).getAllByRole('link')).toHaveLength(2);
    expect(within(tabs).getByRole('link', { name: 'All' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'Recently launched' })).toBeInTheDocument();
  });

  it('a stale ?tab=trending resolves to the All tab, not a hidden third state', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} tab="trending" />);
    const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
    expect(within(tabs).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the active Recently launched tab with aria-current and keeps All inactive', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} tab="recent" />);

    const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
    expect(within(tabs).getByRole('link', { name: 'Recently launched' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
  });

  it('highlights the column that determines the active tab order', () => {
    const page = { items: [launch()], nextCursor: null };
    const { rerender } = render(<LaunchList page={page} sources={oneChainOneSource} error={false} />);
    const table = screen.getByRole('table', { name: /launch list/i });
    const volume = within(table).getByRole('columnheader', { name: /24H volume/i });
    const age = within(table).getByRole('columnheader', { name: /Age/i });
    expect(volume).toHaveAttribute('aria-sort', 'descending');
    expect(volume).toHaveTextContent('↓');
    expect(age).not.toHaveAttribute('aria-sort');

    rerender(<LaunchList page={page} sources={oneChainOneSource} error={false} tab="recent" />);
    expect(age).toHaveAttribute('aria-sort', 'ascending');
    expect(age).toHaveTextContent('↑');
    expect(volume).not.toHaveAttribute('aria-sort');
  });

  it('sorts a metric column in both directions without navigation and marks the active header', () => {
    vi.mocked(getLaunches).mockResolvedValue({ items: [launch()], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const table = screen.getByRole('table', { name: /launch list/i });
    const header = within(table).getByRole('columnheader', { name: /FDV/i });
    fireEvent.click(within(header).getByRole('button', { name: /FDV/i }));
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'fdvUsd', direction: 'desc' }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(header).toHaveTextContent('↓');
    expect(window.location.search).toContain('sort=fdvUsd');

    fireEvent.click(within(header).getByRole('button', { name: /FDV/i }));
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'fdvUsd', direction: 'asc' }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(header).toHaveTextContent('↑');
  });

  it.each([
    ['24H volume', 'volume24hUsd', 'asc'],
    ['Liquidity', 'tvlUsd', 'desc'],
    ['1H', 'change1h', 'desc'],
    ['1D', 'change1d', 'desc'],
    ['Age', 'recent', 'asc'],
  ])('requests sorting when %s is clicked', (label, sort, direction) => {
    vi.mocked(getLaunches).mockResolvedValue({ items: [launch()], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    const table = screen.getByRole('table', { name: /launch list/i });
    const header = within(table).getByRole('columnheader', { name: new RegExp(label, 'i') });
    fireEvent.click(within(header).getByRole('button', { name: new RegExp(label, 'i') }));
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ sort }));
    expect(header).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
  });

  it('shows the approximate USD 24H volume when available, with the quote amount still accessible', () => {
    render(
      <LaunchList
        page={{ items: [launch({ officialVolume24hUsd: '1234.56', officialVolume24hUsdApprox: true, officialVolume24h: '0.5' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByText(/~\$1234\.6/)).toBeInTheDocument();
  });

  it('explains that the volume ranking is updating on 503, and points to the recent tab instead of a generic error', () => {
    render(<LaunchList page={null} sources={oneChainOneSource} error rankingUnavailable />);
    expect(screen.getByRole('status')).toHaveTextContent('Official volume ranking is updating');
    expect(screen.getByRole('link', { name: 'Browse recent launches' })).toHaveAttribute('href', '/launches?tab=recent');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows when the official volume was last computed, from the newest row', () => {
    render(<LaunchList page={{ items: [
      launch({ officialVolume24hUsdAsOf: '2026-10-05T11:00:00.000Z' }),
      launch({ tokenAddress: '0x2222222222222222222222222222222222222222', officialVolume24hUsdAsOf: '2026-10-05T11:30:00.000Z' }),
    ], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    expect(screen.getByText('Official 24h volume as of 2026-10-05 11:30 UTC')).toBeInTheDocument();
  });

  it('shows the honest unavailable state (not a fabricated zero) when officialVolume24hUsd is null', () => {
    render(<LaunchList page={{ items: [launch({ officialVolume24hUsd: null })], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('defaults to the All tab when no tab is given', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const tabs = screen.getByRole('navigation', { name: /filter by tab/i });
    expect(within(tabs).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the active non-default tab when submitting the search form', () => {
    render(
      <LaunchList
        page={{ items: [launch()], nextCursor: 'cursor-2' }}
        sources={oneChainOneSource}
        error={false}
        tab="recent"
      />,
    );

    const form = screen.getByRole('search', { name: /search and filter launches/i });
    expect(within(form).getByDisplayValue('recent')).toHaveAttribute('type', 'hidden');
  });

  it('switches tabs and submits search and lifecycle filters without navigating', async () => {
    vi.mocked(getLaunches).mockResolvedValue({ items: [launch({ name: 'Filtered token' })], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false}
      chainId={[4663]} platform={['pons']} />);

    fireEvent.click(screen.getByRole('link', { name: 'Recently launched' }));
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: [4663], platform: ['pons'], sort: 'recent' }));
    expect(screen.getByRole('link', { name: 'Recently launched' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.search).toContain('tab=recent');

    const form = screen.getByRole('search', { name: /search and filter launches/i });
    fireEvent.change(within(form).getByRole('combobox', { name: /filter by lifecycle/i }), { target: { value: 'trading' } });
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'trading', sort: 'recent' }));
    fireEvent.change(within(form).getByRole('searchbox'), { target: { value: 'demo' } });
    fireEvent.submit(form);
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'demo', status: 'trading', sort: 'recent' }));
    expect(window.location.search).toContain('search=demo');
    expect(window.location.search).toContain('status=trading');
    await screen.findByText('Filtered token');
  });

  it('restores the selected tab and results when browser history moves back', async () => {
    vi.mocked(getLaunches).mockResolvedValue({ items: [launch()], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Recently launched' }));
    expect(screen.getByRole('link', { name: 'Recently launched' })).toHaveAttribute('aria-current', 'page');

    window.history.pushState(null, '', '/launches');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(screen.getByRole('link', { name: /^All$/ })).toHaveAttribute('aria-current', 'page');
    expect(getLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'volume24hUsd' }));
  });

  it('filters without navigation, keeps the menu open, and marks selected options', async () => {
    const sources: Source[] = [
      ...twoChainsTwoPlatforms,
      { id: 'third', chainId: 10, platform: 'third', protocolVersion: 'v1' },
      { id: 'fourth', chainId: 20, platform: 'fourth', protocolVersion: 'v1' },
    ];
    vi.mocked(getLaunches).mockResolvedValue({ items: [launch({ name: 'Filtered token' })], nextCursor: null });
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={sources} error={false}
      chainId={[4663, 1]} platform={['pons', 'other']} />);

    const launchpadFilter = screen.getByRole('navigation', { name: /filter by launchpad/i });
    const chainFilter = screen.getByRole('navigation', { name: /filter by chain/i });
    const menu = launchpadFilter.querySelector('details')!;
    fireEvent.click(menu.querySelector('summary')!);
    expect(menu).toHaveAttribute('open');
    fireEvent.click(within(launchpadFilter).getByRole('button', { name: /third/i }));
    expect(menu).toHaveAttribute('open');
    expect(within(launchpadFilter).getByRole('button', { name: /third/i })).toHaveAttribute('aria-pressed', 'true');
    expect(within(launchpadFilter).getByRole('button', { name: /third/i }).querySelector('[data-selected-check]')).toBeInTheDocument();
    expect(launchpadFilter.querySelector('[data-filter-menu]')).toHaveClass('bg-card');
    expect(getLaunches).toHaveBeenCalledWith({ cursor: undefined, chainId: [4663, 1], platform: ['pons', 'other', 'third'], search: undefined, status: undefined, sort: 'volume24hUsd' });
    await screen.findByText('Filtered token');
    const chainMenu = chainFilter.querySelector('details')!;
    fireEvent.click(chainMenu.querySelector('summary')!);
    fireEvent.click(within(chainFilter).getByRole('button', { name: /chain 10/i }));
    expect(chainMenu).toHaveAttribute('open');
    expect(within(chainFilter).getByRole('button', { name: /chain 10/i })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chainFilter).getByRole('button', { name: /chain 10/i }).querySelector('[data-selected-check]')).toBeInTheDocument();
    expect(chainFilter.querySelector('[data-filter-menu]')).toHaveClass('bg-card');
    expect(getLaunches).toHaveBeenLastCalledWith({ cursor: undefined, chainId: [4663, 1, 10], platform: ['pons', 'other', 'third'], search: undefined, status: undefined, sort: 'volume24hUsd' });
    expect(window.location.search).toContain('chainId=4663%2C1%2C10');
    const form = screen.getByRole('search', { name: /search and filter launches/i });
    expect(within(form).getByDisplayValue('4663,1,10')).toHaveAttribute('name', 'chainId');
    expect(within(form).getByDisplayValue('pons,other,third')).toHaveAttribute('name', 'platform');
  });

  it('keeps the current rows visible while a filter request is pending and replaces them with results', async () => {
    let resolvePage!: (page: { items: LaunchSummary[]; nextCursor: null }) => void;
    vi.mocked(getLaunches).mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }));
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const filter = screen.getByRole('navigation', { name: /filter by launchpad/i });
    fireEvent.click(within(filter).getByRole('button', { name: 'NOXA' }));
    expect(screen.getByRole('table', { name: /launch list/i })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('launch-skeleton-row')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view token a details/i })).toBeInTheDocument();
    expect(screen.queryByText(/no launches match/i)).not.toBeInTheDocument();

    await act(async () => resolvePage({ items: [launch({ name: 'Filtered token' })], nextCursor: null }));
    expect(screen.queryByTestId('launch-skeleton-row')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view filtered token details/i })).toBeInTheDocument();
  });

  it('closes the other filter menu when opening a filter', async () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);
    const launchpad = screen.getByRole('navigation', { name: /filter by launchpad/i }).querySelector('details')!;
    const chain = screen.getByRole('navigation', { name: /filter by chain/i }).querySelector('details')!;
    fireEvent.click(launchpad.querySelector('summary')!);
    expect(launchpad).toHaveAttribute('open');
    fireEvent.click(chain.querySelector('summary')!);
    await waitFor(() => expect(launchpad).not.toHaveAttribute('open'));
    expect(chain).toHaveAttribute('open');
    fireEvent.click(launchpad.querySelector('summary')!);
    await waitFor(() => expect(chain).not.toHaveAttribute('open'));
    expect(launchpad).toHaveAttribute('open');
  });

  it('shows three overlapping logos and the remaining count for four selections', () => {
    const sources: Source[] = [
      ...twoChainsTwoPlatforms,
      { id: 'third', chainId: 10, platform: 'third', protocolVersion: 'v1' },
      { id: 'fourth', chainId: 20, platform: 'fourth', protocolVersion: 'v1' },
    ];
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={sources} error={false}
      chainId={[4663, 1, 10, 20]} platform={['pons', 'other', 'third', 'fourth']} />);
    expect(within(screen.getByRole('navigation', { name: /filter by launchpad/i })).getByText('+1')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: /filter by chain/i })).getByText('+1')).toBeInTheDocument();
  });

  it('shows a launchpad name for one selection and only logos for multiple selections', () => {
    const sources: Source[] = [
      ...twoChainsTwoPlatforms,
      { id: 'third', chainId: 10, platform: 'third', protocolVersion: 'v1' },
    ];
    const page = { items: [launch()], nextCursor: null };
    const { rerender } = render(<LaunchList page={page} sources={sources} error={false} chainId={[4663]} platform={['pons']} />);
    const launchpadSummary = screen.getByRole('navigation', { name: /filter by launchpad/i }).querySelector('summary')!;
    const chainSummary = screen.getByRole('navigation', { name: /filter by chain/i }).querySelector('summary')!;
    expect(launchpadSummary).toHaveTextContent('Pons');
    expect(chainSummary).not.toHaveTextContent('Robinhood Chain');

    rerender(<LaunchList page={page} sources={sources} error={false} chainId={[4663, 1, 10]} platform={['pons', 'other', 'third']} />);
    expect(launchpadSummary).not.toHaveTextContent('Pons');
    expect(launchpadSummary.querySelectorAll('span[aria-hidden="true"] > span')).toHaveLength(3);
    expect(chainSummary.querySelectorAll('span[aria-hidden="true"] > span')).toHaveLength(3);
  });

  it('does not show a next-page link for the default "all" tab', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false} />);
    expect(screen.queryByRole('link', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('shows a search box and status filter that submit as a GET form, preserving the current values', () => {
    render(
      <LaunchList
        page={{ items: [launch()], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
        search="demo"
        status="swept"
      />,
    );

    const form = screen.getByRole('search', { name: /search and filter launches/i });
    expect(form).toHaveAttribute('method', 'get');
    const searchBox = within(form).getByRole('searchbox');
    expect(searchBox).toHaveValue('demo');
    const statusSelect = within(form).getByRole('combobox', { name: /filter by lifecycle/i });
    expect(statusSelect).toHaveValue('swept');
  });

  it('hides the next-page link when there is no further cursor', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    expect(screen.queryByRole('link', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('shows a recoverable error with a retry link when the BE is unreachable, instead of an empty page', () => {
    render(<LaunchList page={null} sources={[]} error={true} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    expect(screen.getByRole('link', { name: /retry/i })).toBeInTheDocument();
  });
});
