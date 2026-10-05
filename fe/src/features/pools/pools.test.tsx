import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PoolSummary } from '@/api/client';
import { PoolList } from './pool-list';
import { PoolDetail } from './pool-detail';

const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const pool: PoolSummary = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'a'.repeat(64)}`,
  currency0: a, currency1: b, displayedToken: a, fee: 3000, tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000', createdBlock: '123', createdTimestamp: null,
  ponsDesignated: true, launchTokenAddress: b, volume24hUsd: null, priceInQuote: null,
  priceUsd: null, fdvUsd: null, tvlUsd: null, change1h: null, change1d: null,
  coverageStatus: 'backfilling', lastTradeTimestamp: null };
describe('Pools UI', () => {
  it('defaults to currency0 globally and preserves Pons side in token scoped links', () => {
    const page = { items: [pool], nextCursor: null, supportedProtocols: ['uniswap_v4'] };
    const { rerender } = render(<PoolList page={page} />);
    const global = screen.getByRole('link', { name: /0x1111.*0x2222/ });
    expect(global).toHaveAttribute('href', expect.stringContaining(`displayedToken=${a}`));
    rerender(<PoolList page={page} tokenAddress={b} />);
    const scoped = screen.getByRole('link', { name: /0x1111.*0x2222/ });
    expect(scoped).toHaveAttribute('href', expect.stringContaining(`displayedToken=${b}`));
    expect(screen.getByText('Pons designated pool')).toBeInTheDocument();
  });
  it('shows missing metrics, coverage and both side switches without APR', () => {
    render(<PoolDetail pool={pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    const viewA = screen.getByRole('link', { name: 'View 0x1111…1111' });
    const viewB = screen.getByRole('link', { name: 'View 0x2222…2222' });
    expect(viewA).toHaveAttribute('aria-current', 'page');
    expect(viewB).toHaveAttribute('href', expect.stringContaining(`displayedToken=${b}`));
    expect(within(screen.getByText('FDV (pool price)').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('backfilling')).toBeInTheDocument();
    expect(screen.queryByText(/APR/i)).not.toBeInTheDocument();
  });
});
