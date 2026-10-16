import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPoolHistory, getPoolLiquidity } from '@/api/client';
import type { PoolDayHistory } from '@/api/client';
import { act } from '@testing-library/react';
import { emitPoolChanged } from '@/hooks/live-events';
import { PoolChartPanel } from './pool-chart-panel';

vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getPoolHistory: vi.fn(), getPoolLiquidity: vi.fn() }));
vi.mock('lightweight-charts', () => ({
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  HistogramSeries: {}, AreaSeries: {},
  createChart: () => ({ addSeries: () => ({ setData: vi.fn() }), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ fitContent: vi.fn() }) }),
}));
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
    expect(screen.getByRole('img', { name: /^volume over/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'TVL' }));
    expect(screen.getByRole('img', { name: /^tvl over/i })).toBeInTheDocument();
  });

  it('keeps the candle-size tabs under Volume and refetches the series for the chosen size', async () => {
    vi.mocked(getPoolHistory).mockResolvedValue({ items: [{ day: 10 * DAY, tradeCount: 1, volumeUsd: '7', tvlUsd: null }], complete: true });
    render(<PoolChartPanel {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    expect(screen.getAllByRole('link', { name: '4H' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('link', { name: '4H' }).at(-1)!);
    expect(getPoolHistory).toHaveBeenCalledWith(pool, '4h');
    await waitFor(() => expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('$7'));
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('Volume');
  });

  it("reloads the Volume series of the range on screen when a swap lands in this pool, and not for another pool", async () => {
    vi.mocked(getPoolHistory).mockResolvedValue({ items: [{ day: 10 * DAY, tradeCount: 2, volumeUsd: '2500', tvlUsd: null }], complete: true });
    render(<PoolChartPanel {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xother' }); });
    expect(getPoolHistory).not.toHaveBeenCalled();
    await act(async () => { emitPoolChanged({ chainId: 4663, poolId: '0xpool' }); });
    expect(getPoolHistory).toHaveBeenCalledTimes(1);
    // The figure rolls digit by digit, so read its accessible label rather than the animated text.
    await waitFor(() => expect(screen.getByLabelText('$2.5K')).toBeInTheDocument());
  });

  it('shows no switcher when only the price chart is available (a V2 pair has no Liquidity or Depth)', () => {
    render(<PoolChartPanel {...props} pool={{ ...(pool as object), protocol: 'uniswap_v2' } as never} history={null} />);
    expect(screen.queryByRole('tablist', { name: 'Chart type' })).not.toBeInTheDocument();
  });

  it('adds Liquidity and Depth to the same switcher for V3 and V4 pools, and not for V2', () => {
    const { unmount } = render(<PoolChartPanel {...props} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent).filter((text) => ['Price', 'Volume', 'Liquidity', 'Depth', 'TVL'].includes(text ?? ''))).toEqual(['Price', 'Volume', 'TVL', 'Liquidity', 'Depth']);
    unmount();
    render(<PoolChartPanel {...props} pool={{ ...(pool as object), protocol: 'uniswap_v2' } as never} />);
    expect(screen.queryByRole('tab', { name: 'Liquidity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Depth' })).not.toBeInTheDocument();
  });

  it('hides the range tabs and the line / candle switch on Liquidity and Depth, leaving only the tab switcher', async () => {
    vi.mocked(getPoolLiquidity).mockResolvedValue({ blockNumber: '1', tickSpacing: 60, feePips: 500, currentTick: 0, price: 1, priceInverse: 1,
      token0: { address: '0xa', decimals: 18 }, token1: { address: '0xb', decimals: 18 }, ranges: [{ tickLower: -600, tickUpper: 600, priceLower: 0.9, priceUpper: 1.1, liquidity: '5', active: true }],
      depth: { asks: [{ price: 1.01, amount0: 1, total1: 1, cumulative1: 1 }], bids: [{ price: 0.99, amount0: 1, total1: 1, cumulative1: 1 }], spreadPercent: 0.1 }, complete: true, unavailableReason: null } as never);
    render(<PoolChartPanel {...props} />);
    expect(screen.getByRole('tab', { name: 'Candlestick chart' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Liquidity' }));
    await waitFor(() => expect(screen.getByRole('img', { name: /^liquidity of/i })).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Candlestick chart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '4H' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Liquidity' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Depth' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Depth chart' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: '4H' })).not.toBeInTheDocument();
  });
});
