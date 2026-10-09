import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAll, type SearchResults } from '@/api/client';
import { GlobalSearch } from './global-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), searchAll: vi.fn() }));

const results: SearchResults = {
  tokens: [{ chainId: 4663, tokenAddress: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null, platform: 'pons' }],
  pools: [{ chainId: 4663, protocol: 'uniswap_v4', poolId: '0xbbb', fee: 3000, currency0: '0xaaa', currency1: '0x0',
    launchToken: { address: '0xaaa', name: 'Zorb', symbol: 'ZRB', logoUri: null } }],
};

async function typeQuery(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe('GlobalSearch', () => {
  beforeEach(() => { vi.useFakeTimers(); push.mockReset(); vi.mocked(searchAll).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('does not search for a query shorter than two characters', async () => {
    render(<GlobalSearch />);
    await typeQuery('z');
    expect(searchAll).not.toHaveBeenCalled();
  });

  it('shows token and pool hits after the debounce, linking to the launch and the pool page', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    await typeQuery('zorb');
    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchAll).mock.calls[0]![0]).toBe('zorb');
    expect(screen.getByRole('option', { name: /Zorb/ })).toHaveAttribute('href', '/launches/4663/0xaaa');
    expect(screen.getByRole('option', { name: /ZRB pool/ })).toHaveAttribute('href', expect.stringContaining('/pools/4663/uniswap_v4/0xbbb?displayedToken=0xaaa'));
  });

  it('navigates to the highlighted option with the arrow keys and Enter', async () => {
    vi.mocked(searchAll).mockResolvedValue(results);
    render(<GlobalSearch />);
    await typeQuery('zorb');
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/pools/4663/uniswap_v4/0xbbb'));
  });

  it('says so when nothing matches, and when the search request fails', async () => {
    vi.mocked(searchAll).mockResolvedValueOnce({ tokens: [], pools: [] });
    render(<GlobalSearch />);
    await typeQuery('nothing');
    expect(screen.getByText(/No results for/)).toBeInTheDocument();

    vi.mocked(searchAll).mockRejectedValueOnce(new Error('boom'));
    await typeQuery('other');
    expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/i);
  });
});
