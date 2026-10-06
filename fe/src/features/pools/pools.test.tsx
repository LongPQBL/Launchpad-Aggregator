import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PoolSummary } from '@/api/client';
import { PoolList } from './pool-list';
import { PoolDetail } from './pool-detail';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined }),
  useReadContract: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useSimulateContract: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), status: 'idle', error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ status: 'idle', error: null }),
}));

const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const pool: PoolSummary = { chainId: 4663, protocol: 'uniswap_v4', poolId: `0x${'a'.repeat(64)}`,
  currency0: a, currency1: b, displayedToken: a, fee: 3000, tickSpacing: 60,
  currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
  currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: 18,
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
  it('shows a protocol/fee badge and real token symbols/logos when the API resolved them', () => {
    const resolved: PoolSummary = { ...pool, currency0Symbol: 'GUY', currency0LogoUri: 'https://example.com/guy.png',
      currency1Symbol: 'ETH', currency1LogoUri: 'https://example.com/eth.png' };
    render(<PoolList page={{ items: [resolved], nextCursor: null, supportedProtocols: ['uniswap_v4'] }} />);
    expect(screen.getByRole('link', { name: 'GUY / ETH' })).toBeInTheDocument();
    expect(screen.getByText('v4 · 0.3%')).toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'GUY / ETH' })).toBeInTheDocument();
    expect(screen.getByText('v4 · 0.3%')).toBeInTheDocument();
  });
  it('PoolDetail does not show a Swap panel for a V4 pool (not yet supported)', () => {
    render(<PoolDetail pool={pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByLabelText('Flip swap direction')).not.toBeInTheDocument();
  });
  it('PoolDetail shows a Swap panel for a V3 pool once both currencies\' decimals are known', () => {
    const v3Pool: PoolSummary = { ...pool, protocol: 'uniswap_v3' };
    render(<PoolDetail pool={v3Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.getByLabelText('Flip swap direction')).toBeInTheDocument();
  });
  it('PoolDetail hides the Swap panel for a V3 pool when a currency\'s decimals are unknown, rather than guessing', () => {
    const v3Pool: PoolSummary = { ...pool, protocol: 'uniswap_v3', currency1Decimals: null };
    render(<PoolDetail pool={v3Pool} trades={{ items: [], nextCursor: null }} candles={null} />);
    expect(screen.queryByLabelText('Flip swap direction')).not.toBeInTheDocument();
  });
});
