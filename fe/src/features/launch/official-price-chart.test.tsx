import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { OfficialPriceChart, rangeChangePercent } from './official-price-chart';

const { subscribeCrosshairMoveMock, chartStub } = vi.hoisted(() => {
  const subscribeCrosshairMoveMock = vi.fn();
  const chartStub: unknown = new Proxy(() => chartStub, {
    get: (_target, prop) => (prop === 'subscribeCrosshairMove' ? subscribeCrosshairMoveMock : chartStub),
    apply: () => chartStub,
  });
  return { subscribeCrosshairMoveMock, chartStub };
});

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, createChart: () => chartStub, createSeriesMarkers: () => chartStub,
}));

const candle = (bucketStart: number, close: string) => ({
  intervalSeconds: 60, bucketStart, open: close, high: close, low: close, close, quoteVolume: '1',
});
const baseProps = {
  priceText: '0.0108', priceStale: false, graduationTime: null, quoteSymbol: 'ETH', coverageStatus: 'caught_up',
  currency: 'quote' as const, intervalSeconds: 60, tokenSymbol: 'E2E', source: {},
};

// jsdom makes React listen for the vendor-prefixed event name, so that is what ends a roll in tests.
const settleRolls = () => act(() => {
  screen.queryAllByTestId('digit-roll').forEach((el) => el.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true })));
});

describe('rangeChangePercent', () => {
  it('computes the change from the start price', () => {
    expect(Number(rangeChangePercent(100, 88))).toBeCloseTo(-12);
  });
  it('is null when an end is unusable', () => {
    expect(rangeChangePercent(0, 1)).toBeNull();
    expect(rangeChangePercent(Number.NaN, 1)).toBeNull();
  });
});

describe('OfficialPriceChart change', () => {
  const candles = { items: [candle(1_700_000_060, '90'), candle(1_700_000_000, '100'), candle(1_700_000_120, '80')], complete: true };

  it('shows change from first candle to latest, and to the hovered point while hovering', () => {
    render(<OfficialPriceChart {...baseProps} candles={candles} />);
    expect(screen.getByTestId('official-price-change').textContent).toContain('20.00%');

    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;
    act(() => {
      handler({
        time: 1_700_000_060 as Time,
        seriesData: new Map([[chartStub, { time: 1_700_000_060 as Time, open: 90, high: 90, low: 90, close: 90 }]]),
      } as unknown as MouseEventParams<Time>);
    });
    settleRolls();
    expect(screen.getByTestId('official-price-change').textContent).toContain('10.00%');

    act(() => { handler({ seriesData: new Map() } as unknown as MouseEventParams<Time>); });
    settleRolls();
    expect(screen.getByTestId('official-price-change').textContent).toContain('20.00%');
  });

  it('hides the change when there are no candles', () => {
    render(<OfficialPriceChart {...baseProps} candles={{ items: [], complete: false }} />);
    expect(screen.queryByTestId('official-price-change')).toBeNull();
  });
});
