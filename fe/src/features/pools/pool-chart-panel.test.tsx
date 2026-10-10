import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPoolHistory } from '@/api/client';
import type { PoolDayHistory } from '@/api/client';
import { PoolChartPanel } from './pool-chart-panel';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getPoolHistory: vi.fn() }));
vi.mock('./pool-chart', () => ({ PoolChart: ({ trailing }: { trailing?: React.ReactNode }) => <div data-testid="price-chart">{trailing}</div> }));

const DAY = 86_400;
const history = { items: [{ day: 10 * DAY, tradeCount: 1, volumeUsd: '1500', tvlUsd: '40000' }] as PoolDayHistory[], complete: true };
const pool = { chainId: 4663, protocol: 'uniswap_v4', poolId: '0xpool', displayedToken: '0xtoken', priceInQuote: '1', priceUsd: null } as never;
const props = { pool, candles: { items: [], complete: true }, history, coverageStatus: 'complete', quoteSymbol: 'ETH', tokenSymbol: 'TKN' };

describe('PoolChartPanel', () => {
  beforeEach(() => { vi.mocked(getPoolHistory).mockReset(); });

  it('starts on Price and switches the chart type with the Price / Volume tabs', () => {
    render(<PoolChartPanel {...props} />);
    expect(screen.getByTestId('price-chart')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Price' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    expect(screen.getByTestId('price-chart').parentElement).toHaveAttribute('hidden');
    expect(screen.getByRole('img', { name: /daily volume/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'TVL' })).not.toBeInTheDocument();
  });

  it('keeps the interval tabs under Volume and refetches the series for the chosen interval', async () => {
    vi.mocked(getPoolHistory).mockResolvedValue({ items: [{ day: 10 * DAY, tradeCount: 1, volumeUsd: '7', tvlUsd: null }], complete: true });
    render(<PoolChartPanel {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    expect(screen.getAllByRole('link', { name: '5m' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('link', { name: '5m' }).at(-1)!);
    expect(getPoolHistory).toHaveBeenCalledWith(pool, 300);
    expect(await screen.findByTestId('history-bar')).toBeInTheDocument();
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('$7');
  });

  it('shows no switcher when only the price chart is available', () => {
    render(<PoolChartPanel {...props} history={null} />);
    expect(screen.queryByRole('tablist', { name: 'Chart type' })).not.toBeInTheDocument();
  });
});
