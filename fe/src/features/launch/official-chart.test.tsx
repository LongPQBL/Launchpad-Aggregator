import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficialChart } from './official-chart';

vi.mock('lightweight-charts', () => {
  // Any method call on the chart or series is a no-op; the test checks the markup, not the canvas.
  const stub: unknown = new Proxy(() => stub, { get: () => stub, apply: () => stub });
  return { CandlestickSeries: {}, createChart: () => stub, createSeriesMarkers: () => stub };
});

const props = { candles: [], graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'caught_up' };

describe('OfficialChart interval tabs', () => {
  it('offers 1m, 5m, 15m, 1h, and 1D, and marks the active one', () => {
    render(<OfficialChart {...props} intervalSeconds={3600} currency="usd" />);
    const nav = screen.getByRole('navigation', { name: 'Chart interval' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['1m', '5m', '15m', '1h', '1D']);
    expect(within(nav).getByText('1h')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1m')).toHaveAttribute('href', '?currency=usd&interval=60');
  });

  it('keeps the selected interval when switching currency', () => {
    render(<OfficialChart {...props} intervalSeconds={300} currency="quote" />);
    expect(screen.getByRole('link', { name: 'USD' })).toHaveAttribute('href', '?currency=usd&interval=300');
  });
});
