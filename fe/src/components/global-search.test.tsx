import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAll, type SearchResults } from '@/api/client';
import { GlobalSearch } from './global-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), searchAll: vi.fn() }));

const results: SearchResults = {
  tokens: [{ chainId: 4663, tokenAddress: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null,
    platform: 'pons', priceUsd: '0.05', change1d: '12.5' }],
  pools: [{ chainId: 4663, protocol: 'uniswap_v4', poolId: '0xbbb', fee: 3000,
    currency0: '0xaaa', currency1: '0x0000000000000000000000000000000000000000',
    currency0Symbol: 'ZRB', currency0LogoUri: null, currency1Symbol: 'ETH', currency1LogoUri: null,
    volume24hUsd: '1234', ponsDesignated: false,
    launchToken: { address: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null } }],
};

async function typeQuery(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe('GlobalSearch', () => {
  beforeEach(() => { vi.useFakeTimers(); push.mockReset(); vi.mocked(searchAll).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('opens a centered search dialog from the icon button and focuses its input', () => {
    render(<GlobalSearch />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    const dialog = screen.getByRole('dialog', { name: 'Search tokens and pools' });
    expect(dialog.parentElement).toHaveClass('items-center');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('finds tokens and pools from one character and displays market figures in separate sections', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    await typeQuery('z');
    expect(searchAll).toHaveBeenCalledWith('z', expect.any(AbortSignal), undefined);
    expect(screen.getByRole('group', { name: 'Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Pools' })).toBeInTheDocument();
    const token = screen.getByRole('option', { name: /Zorb/ });
    expect(token).toHaveAttribute('href', '/launches/4663/0xaaa');
    expect(within(token).getByText('$0.05')).toBeInTheDocument();
    expect(within(token).getByText('12.50%')).toBeInTheDocument();
    const pool = screen.getByRole('option', { name: /ZRB \/ ETH/ });
    expect(pool).toHaveAttribute('href', expect.stringContaining('/pools/4663/uniswap_v4/0xbbb'));
    expect(within(pool).getByText(/v4 · 0.3%/)).toBeInTheDocument();
    expect(within(pool).getByText('$1.23K')).toBeInTheDocument();
  });

  it('shows fallback logos and unavailable figures when a search response omits optional fields', async () => {
    const incomplete = {
      tokens: results.tokens.map((token) => ({ ...token, logoUri: undefined, priceUsd: undefined, change1d: undefined })),
      pools: results.pools.map((pool) => ({ ...pool, currency0LogoUri: undefined, currency1LogoUri: undefined, volume24hUsd: undefined })),
    } as unknown as SearchResults;
    vi.mocked(searchAll).mockResolvedValue(incomplete);
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    await typeQuery('z');
    expect(within(screen.getByRole('option', { name: /Zorb/ })).getAllByText('—')).toHaveLength(2);
    expect(within(screen.getByRole('option', { name: /ZRB \/ ETH/ })).getByText('—')).toBeInTheDocument();
  });

  it('filters the displayed result groups with All, Tokens and Pools tabs', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    await typeQuery('z');
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));
    expect(screen.getByRole('group', { name: 'Tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Pools' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(screen.queryByRole('group', { name: 'Tokens' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Pools' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByRole('group')).toHaveLength(2);
  });

  it('searches within selected networks and All networks clears the filter', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    await typeQuery('z');
    fireEvent.click(screen.getByRole('button', { name: 'Filter by network' }));
    fireEvent.click(screen.getByRole('button', { name: 'Robinhood Chain' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(searchAll).toHaveBeenLastCalledWith('z', expect.any(AbortSignal), [4663]);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by network' }));
    fireEvent.click(screen.getByRole('button', { name: 'All networks' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(searchAll).toHaveBeenLastCalledWith('z', expect.any(AbortSignal), undefined);
  });

  it('keeps keyboard navigation and closes after selecting a result', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Search tokens and pools' }));
    await typeQuery('z');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/pools/4663/uniswap_v4/0xbbb'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
