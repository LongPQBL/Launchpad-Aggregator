import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaunchChartPanel } from './launch-chart-panel';

vi.mock('./official-price-chart', () => ({ OfficialPriceChart: ({ trailing }: { trailing?: React.ReactNode }) => <div data-testid="launch-price-chart">{trailing}</div> }));

const price = { priceText: '$1', priceStale: false, candles: null, graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'complete',
  currency: 'quote' as const, intervalSeconds: 3600, tokenSymbol: 'TKN', source: { launch: { chainId: 4663, tokenAddress: '0xabc' } } };
const history = { items: [{ day: 864_000, tradeCount: 1, volumeUsd: '1500', tvlUsd: '40000' }], complete: true };

describe('LaunchChartPanel', () => {
  it('adds Volume and TVL next to Price when the launch has a Volume / TVL history', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} />);
    expect(screen.getByRole('tab', { name: 'Price' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'TVL' }));
    expect(screen.getByRole('img', { name: /daily tvl/i })).toBeInTheDocument();
  });

  it('scoped to the curve it offers Price and Volume but no TVL tab', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={history} venue="curve" />);
    expect(screen.getByRole('tab', { name: 'Price' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'TVL' })).not.toBeInTheDocument();
  });

  it('shows only the price chart, with no tabs, when the launch has no Volume / TVL history', () => {
    render(<LaunchChartPanel {...price} chainId={4663} tokenAddress="0xabc" history={null} />);
    expect(screen.getByTestId('launch-price-chart')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Chart type' })).not.toBeInTheDocument();
  });
});
