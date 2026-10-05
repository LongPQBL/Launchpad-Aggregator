import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LaunchSummary, Source } from '@/api/client';
import { LaunchList } from './launch-list';

function launch(overrides: Partial<LaunchSummary> = {}): LaunchSummary {
  return {
    chainId: 4663,
    tokenAddress: '0xaaa',
    name: 'Token A',
    symbol: 'TKA',
    platform: 'pons',
    protocolVersion: 'v2',
    quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: 18 },
    lifecycleStatus: 'trading',
    officialVolume24h: '12.5',
    coverageStatus: 'caught_up',
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
    expect(within(row).getByText('(—)')).toBeInTheDocument();
  });

  it('shows a human-readable lifecycle label and chain name instead of raw enum/id values', () => {
    render(
      <LaunchList
        page={{ items: [launch({ lifecycleStatus: 'swept', chainId: 4663 })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByText(/Swept/)).toBeInTheDocument();
    expect(within(table).getByText('Robinhood Chain')).toBeInTheDocument();
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

    const names = screen.getAllByRole('link', { name: /Newest|Older/i }).map((link) => link.textContent);
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
    expect(within(table).getByText(/\$269\.17/)).toBeInTheDocument();
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
    expect(within(table).getByRole('columnheader', { name: '1H %' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '1D %' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Age' })).toBeInTheDocument();
    expect(within(table).getByText('$1000')).toBeInTheDocument();
    expect(within(table).getByText('+12.5%')).toBeInTheDocument();
    expect(within(table).getByText('-5%')).toBeInTheDocument();
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
    expect(within(row).getByText('1H %')).toBeInTheDocument();
    expect(within(row).getByText('1D %')).toBeInTheDocument();
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

  it('hides the chain filter when every source shares the same chain', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    expect(screen.queryByRole('navigation', { name: /filter by chain/i })).not.toBeInTheDocument();
  });

  it('shows the chain filter when sources span more than one chain', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    expect(screen.getByRole('navigation', { name: /filter by chain/i })).toBeInTheDocument();
  });

  it('renders a real Launchpad filter populated from distinct platforms in sources, even with a single option', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const select = screen.getByRole('combobox', { name: /filter by launchpad/i });
    expect(within(select).getByRole('option', { name: /pons/i })).toBeInTheDocument();
  });

  it('lists every distinct platform from sources in the Launchpad filter, deduped', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    const select = screen.getByRole('combobox', { name: /filter by launchpad/i });
    expect(within(select).getAllByRole('option')).toHaveLength(3); // "All launchpads" + pons + other
    expect(within(select).getByRole('option', { name: /other/i })).toBeInTheDocument();
  });

  it('keeps the selected Launchpad filter on the next-page link', () => {
    render(
      <LaunchList
        page={{ items: [launch()], nextCursor: 'cursor-2' }}
        sources={oneChainOneSource}
        error={false}
        platform="pons"
      />,
    );

    const nextLink = screen.getByRole('link', { name: /next page/i });
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('platform=pons'));
  });

  it('shows a next-page link built from nextCursor when more launches are available', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false} />);

    const nextLink = screen.getByRole('link', { name: /next page/i });
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('cursor=cursor-2'));
  });

  it('keeps the current search and status filters on the next-page link', () => {
    render(
      <LaunchList
        page={{ items: [launch()], nextCursor: 'cursor-2' }}
        sources={oneChainOneSource}
        error={false}
        search="demo"
        status="swept"
      />,
    );

    const nextLink = screen.getByRole('link', { name: /next page/i });
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('search=demo'));
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('status=swept'));
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

  it('shows the approximate USD 24H volume when available, with the quote amount still accessible', () => {
    render(
      <LaunchList
        page={{ items: [launch({ officialVolume24hUsd: '1234.56', officialVolume24hUsdApprox: true, officialVolume24h: '0.5' })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );
    const table = screen.getByRole('table', { name: /launch list/i });
    expect(within(table).getByText(/~\$1234\.56/)).toBeInTheDocument();
  });

  it('explains that the volume ranking is updating on 503, and points to the recent tab instead of a generic error', () => {
    render(<LaunchList page={null} sources={oneChainOneSource} error rankingUnavailable />);
    expect(screen.getByRole('status')).toHaveTextContent('Official volume ranking is updating');
    expect(screen.getByRole('link', { name: 'Browse recent launches' })).toHaveAttribute('href', '/?tab=recent');
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

  it('keeps the active non-default tab on the next-page link and when submitting the search form', () => {
    render(
      <LaunchList
        page={{ items: [launch()], nextCursor: 'cursor-2' }}
        sources={oneChainOneSource}
        error={false}
        tab="recent"
      />,
    );

    const nextLink = screen.getByRole('link', { name: /next page/i });
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('tab=recent'));
    const form = screen.getByRole('search', { name: /search and filter launches/i });
    expect(within(form).getByDisplayValue('recent')).toHaveAttribute('type', 'hidden');
  });

  it('does not add a tab param to links for the default "all" tab', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false} />);

    const nextLink = screen.getByRole('link', { name: /next page/i });
    expect(nextLink).toHaveAttribute('href', expect.not.stringContaining('tab='));
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
