import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { PoolChart } from './pool-chart';

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

const candle = (bucketStart: number, close: string) => ({ intervalSeconds: 3600, bucketStart, open: close, high: close, low: close, close, tradeCount: 1 });
const pool = { chainId: 4663, protocol: 'uniswap_v4', poolId: '0x1', displayedToken: '0xabc', priceInQuote: '80', priceUsd: null };

// jsdom makes React listen for the vendor-prefixed event name, so that is what ends a roll in tests.
const settleRolls = () => act(() => {
  screen.queryAllByTestId('digit-roll').forEach((el) => el.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true })));
});

describe('PoolChart price change', () => {
  it('shows the change across the visible candles next to the price, following the hovered point', () => {
    render(<PoolChart pool={pool} candles={{ items: [candle(3600, '100'), candle(0, '110'), candle(7200, '80')], complete: true }}
      coverageStatus="caught_up" quoteSymbol="ETH" tokenSymbol="AI" />);
    expect(screen.getByTestId('pool-price-change').textContent).toContain('27.27%');
    const handler = subscribeCrosshairMoveMock.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;
    act(() => {
      handler({ time: 3600 as Time, seriesData: new Map([[chartStub, { time: 3600 as Time, open: 100, high: 100, low: 100, close: 99 }]]) } as unknown as MouseEventParams<Time>);
    });
    settleRolls();
    expect(screen.getByTestId('pool-price-change').textContent).toContain('10.00%');
  });
  it('hides the change when there are no candles', () => {
    render(<PoolChart pool={pool} candles={{ items: [], complete: false }} coverageStatus="backfilling" quoteSymbol="ETH" tokenSymbol="AI" />);
    expect(screen.queryByTestId('pool-price-change')).toBeNull();
  });
});
