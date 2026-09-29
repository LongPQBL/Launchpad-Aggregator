import { render, screen, within } from '@testing-library/react';
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
  it('shows a human-readable lifecycle label and chain name instead of raw enum/id values', () => {
    render(
      <LaunchList
        page={{ items: [launch({ lifecycleStatus: 'swept', chainId: 4663 })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    const table = screen.getByRole('table', { name: /danh sách launch/i });
    expect(within(table).getByText(/Swept/)).toBeInTheDocument();
    expect(within(table).getByText('Robinhood Chain')).toBeInTheDocument();
    expect(within(table).queryByText('trading')).not.toBeInTheDocument();
  });

  it('renders each launch as a row linking to its detail page', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    const table = screen.getByRole('table', { name: /danh sách launch/i });
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

  it('shows "Chưa có dữ liệu" when officialVolume24h is null instead of a fabricated zero', () => {
    render(
      <LaunchList
        page={{ items: [launch({ officialVolume24h: null })], nextCursor: null }}
        sources={oneChainOneSource}
        error={false}
      />,
    );

    expect(screen.getByText('Chưa có dữ liệu')).toBeInTheDocument();
    expect(screen.queryByText(/\b0(\.0+)?\s*ROBIN\b/)).not.toBeInTheDocument();
  });

  it('hides the chain filter when every source shares the same chain', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    expect(screen.queryByRole('navigation', { name: /lọc theo chain/i })).not.toBeInTheDocument();
  });

  it('shows the chain filter when sources span more than one chain', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    expect(screen.getByRole('navigation', { name: /lọc theo chain/i })).toBeInTheDocument();
  });

  it('never renders a source/platform filter, since be/src/api/routes/launches.ts has no platform query param to back it', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={twoChainsTwoPlatforms} error={false} />);

    expect(screen.queryByRole('navigation', { name: /lọc theo sàn/i })).not.toBeInTheDocument();
  });

  it('shows a next-page link built from nextCursor when more launches are available', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: 'cursor-2' }} sources={oneChainOneSource} error={false} />);

    const nextLink = screen.getByRole('link', { name: /trang sau/i });
    expect(nextLink).toHaveAttribute('href', expect.stringContaining('cursor=cursor-2'));
  });

  it('hides the next-page link when there is no further cursor', () => {
    render(<LaunchList page={{ items: [launch()], nextCursor: null }} sources={oneChainOneSource} error={false} />);

    expect(screen.queryByRole('link', { name: /trang sau/i })).not.toBeInTheDocument();
  });

  it('shows a recoverable error with a retry link when the BE is unreachable, instead of an empty page', () => {
    render(<LaunchList page={null} sources={[]} error={true} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/không tải được/i);
    expect(screen.getByRole('link', { name: /thử lại/i })).toBeInTheDocument();
  });
});
