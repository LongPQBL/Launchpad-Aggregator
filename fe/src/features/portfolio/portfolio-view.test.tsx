import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWalletPositions, type WalletPosition } from '@/api/client';
import { PortfolioView } from './portfolio-view';

const wagmi = vi.hoisted(() => ({ address: undefined as string | undefined, balances: undefined as unknown }));
vi.mock('wagmi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  useAccount: () => ({ address: wagmi.address }),
  useReadContracts: () => ({ data: wagmi.balances }),
}));
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getWalletPositions: vi.fn() }));

function position(overrides: Partial<WalletPosition> & { address?: string; symbol?: string } = {}): WalletPosition {
  const { address = '0xaaa', symbol = 'ZRB', ...rest } = overrides;
  return {
    token: { chainId: 4663, tokenAddress: address, name: 'Zorb', symbol, logoUri: null, decimals: 18 },
    tradeCount: 3, buyCount: 2, sellCount: 1, firstTradeAt: 1, lastTradeAt: 2,
    quoteAsset: { address: '0x0', symbol: 'ETH' }, quoteSpent: '4', quoteReceived: '2', priceUsd: '2', ...rest,
  };
}
const balance = (units: bigint) => ({ status: 'success', result: units * 10n ** 18n });

beforeEach(() => { wagmi.address = '0xwallet'; wagmi.balances = undefined; vi.mocked(getWalletPositions).mockReset(); });

describe('PortfolioView', () => {
  it('asks to connect a wallet when none is connected, without calling the API', () => {
    wagmi.address = undefined;
    render(<PortfolioView />);
    expect(screen.getByRole('status')).toHaveTextContent(/Connect your wallet/);
    expect(getWalletPositions).not.toHaveBeenCalled();
  });

  it('shows skeleton rows while loading, then balances valued at the current USD price and a total', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getWalletPositions>>) => void;
    vi.mocked(getWalletPositions).mockReturnValue(new Promise((r) => { resolve = r; }));
    wagmi.balances = [balance(1500n)];
    render(<PortfolioView />);
    expect(await screen.findAllByTestId('portfolio-skeleton-row')).toHaveLength(6);

    await act(async () => resolve({ items: [position()] }));
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText('1.5K')).toBeInTheDocument();
    expect(within(row).getByText('$3K')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-total')).toHaveTextContent('$3K');
    expect(within(row).getByText('4 / 2 ETH')).toBeInTheDocument();
    expect(screen.queryAllByTestId('portfolio-skeleton-row')).toHaveLength(0);
  });

  it('hides zero balances by default and shows them when unticked', async () => {
    vi.mocked(getWalletPositions).mockResolvedValue({ items: [position(), position({ address: '0xbbb', symbol: 'GONE' })] });
    wagmi.balances = [balance(10n), balance(0n)];
    render(<PortfolioView />);
    await screen.findByText('ZRB');
    expect(screen.queryByText('GONE')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hide zero balances'));
    expect(screen.getByText('GONE')).toBeInTheDocument();
  });

  it('shows an em dash, not a fake zero, for an unpriced token, and notes it is excluded from the total', async () => {
    vi.mocked(getWalletPositions).mockResolvedValue({ items: [position({ priceUsd: null })] });
    wagmi.balances = [balance(5n)];
    render(<PortfolioView />);
    await screen.findByText('ZRB');
    expect(screen.getByTestId('portfolio-total')).toHaveTextContent('—');
    expect(screen.getByText(/Excludes tokens without a USD price/)).toBeInTheDocument();
  });

  it('reports a failed request', async () => {
    vi.mocked(getWalletPositions).mockRejectedValue(new Error('boom'));
    render(<PortfolioView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load/);
  });
});
