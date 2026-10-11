import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEventParams, Time } from 'lightweight-charts';
import type { PoolDayHistory } from '@/api/client';
import { PoolHistoryChart, formatBucketTime, latestTvl, windowLabel, windowTotal } from './pool-history-chart';

const { setData, addSeries, subscribeCrosshairMove, fitContent } = vi.hoisted(() => {
  const setData = vi.fn();
  const fitContent = vi.fn();
  return { setData, fitContent, subscribeCrosshairMove: vi.fn(), addSeries: vi.fn((_type?: unknown, _options?: unknown) => ({ setData })) };
});
vi.mock('lightweight-charts', () => ({
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  HistogramSeries: { kind: 'histogram' }, AreaSeries: { kind: 'area' },
  createChart: () => ({ addSeries, subscribeCrosshairMove, unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ fitContent }) }),
}));

const DAY = 86_400;
const items: PoolDayHistory[] = [
  { day: 10 * DAY, tradeCount: 3, volumeUsd: '1500', tvlUsd: '40000' },
  { day: 11 * DAY, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
  { day: 12 * DAY, tradeCount: 2, volumeUsd: '500', tvlUsd: '50000' },
];

beforeEach(() => { setData.mockClear(); addSeries.mockClear(); subscribeCrosshairMove.mockClear(); });

describe('history helpers', () => {
  it('sums the available buckets and counts the unavailable ones; nothing to sum is null', () => {
    expect(windowTotal(items)).toEqual({ total: '2000', missing: 0 });
    expect(windowTotal([...items, { day: 13 * DAY, tradeCount: 1, volumeUsd: null, tvlUsd: null }])).toEqual({ total: '2000', missing: 1 });
    expect(windowTotal([{ day: 13 * DAY, tradeCount: 1, volumeUsd: null, tvlUsd: null }])).toBeNull();
    expect(windowTotal([])).toBeNull();
  });
  it('finds the latest TVL and formats UTC bucket times and window labels', () => {
    expect(latestTvl(items)?.day).toBe(12 * DAY);
    expect(latestTvl(items.map((item) => ({ ...item, tvlUsd: null })))).toBeNull();
    expect(formatBucketTime(10 * DAY, DAY)).toBe('Jan 11, 1970');
    expect(formatBucketTime(10 * DAY + 3600 * 14 + 1800, 60)).toBe('Jan 11, 14:30');
    expect([windowLabel(3600), windowLabel(86_400), windowLabel(7 * 86_400)]).toEqual(['1 hour', '1 day', '7 days']);
  });
});

describe('PoolHistoryChart', () => {
  it('draws Volume as a histogram and sends a gap, not a zero, for an unavailable bucket', () => {
    render(<PoolHistoryChart items={[...items, { day: 13 * DAY, tradeCount: 1, volumeUsd: null, tvlUsd: null }]} complete metric="volume" />);
    expect(addSeries.mock.calls[0]![0]).toMatchObject({ kind: 'histogram' });
    const points = setData.mock.calls.at(-1)![0] as Array<{ time: number; value?: number }>;
    expect(points).toEqual([
      { time: 10 * DAY, value: 1500 }, { time: 11 * DAY, value: 0 }, { time: 12 * DAY, value: 500 }, { time: 13 * DAY },
    ]);
  });

  it('draws TVL as an area and leaves buckets without a snapshot as gaps', () => {
    render(<PoolHistoryChart items={items} complete metric="tvl" />);
    expect(addSeries.mock.calls[0]![0]).toMatchObject({ kind: 'area' });
    expect(setData.mock.calls.at(-1)![0]).toEqual([{ time: 10 * DAY, value: 40000 }, { time: 11 * DAY }, { time: 12 * DAY, value: 50000 }]);
  });

  it('shows the window total by default and the hovered bucket on hover, with "Unavailable" for a gap', () => {
    render(<PoolHistoryChart items={[...items, { day: 13 * DAY, tradeCount: 1, volumeUsd: null, tvlUsd: null }]} complete metric="volume" intervalSeconds={DAY} />);
    const readout = screen.getByTestId('pool-history-readout');
    // One bucket is null: the total is a minimum and says so, instead of claiming the whole window.
    expect(readout).toHaveTextContent('$2K+');
    expect(readout).toHaveTextContent('1 of 4 buckets unavailable');
    const onMove = subscribeCrosshairMove.mock.calls.at(-1)![0] as (param: MouseEventParams<Time>) => void;
    act(() => { onMove({ time: (10 * DAY) as Time } as MouseEventParams<Time>); });
    expect(readout).toHaveTextContent('$1.5K');
    expect(readout).toHaveTextContent('Volume · Jan 11, 1970');
    act(() => { onMove({ time: (13 * DAY) as Time } as MouseEventParams<Time>); });
    expect(readout).toHaveTextContent('Unavailable');
    act(() => { onMove({} as MouseEventParams<Time>); });
    expect(readout).toHaveTextContent('Total, last 4 days');
  });

  it('says Unavailable when no bucket has a value', () => {
    render(<PoolHistoryChart items={[{ day: 13 * DAY, tradeCount: 1, volumeUsd: null, tvlUsd: null }]} complete metric="volume" intervalSeconds={DAY} />);
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('Unavailable');
  });

  it('shows the total when every bucket is available, and the latest value for TVL', () => {
    const { unmount } = render(<PoolHistoryChart items={items} complete metric="volume" intervalSeconds={DAY} />);
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('$2K');
    unmount();
    render(<PoolHistoryChart items={items} complete metric="tvl" intervalSeconds={DAY} />);
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('$50K');
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('Latest, Jan 13, 1970');
  });

  it('says so when no TVL was recorded, and hides the chart', () => {
    render(<PoolHistoryChart items={items.map((day) => ({ ...day, tvlUsd: null }))} complete metric="tvl" />);
    expect(screen.getByRole('status')).toHaveTextContent('No TVL history recorded');
    expect(screen.getByTestId('history-chart-container').parentElement).toHaveClass('hidden');
  });

  it('shows loading and error states instead of the chart', () => {
    const { rerender } = render(<PoolHistoryChart items={items} complete metric="volume" loading />);
    expect(screen.getByRole('status', { name: 'Loading history' })).toBeInTheDocument();
    rerender(<PoolHistoryChart items={items} complete metric="volume" error />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this history.');
  });

  it('warns when the pool is still being indexed', () => {
    render(<PoolHistoryChart items={items} complete={false} metric="volume" />);
    expect(screen.getByText(/still being indexed/)).toBeInTheDocument();
  });
});

import { formatUsdAxis, withZeroBaseline } from './pool-history-chart';

describe('withZeroBaseline', () => {
  it('includes 0 when every value is (nearly) the same, so axis ticks are not all identical', () => {
    expect(withZeroBaseline({ priceRange: { minValue: 3495, maxValue: 3495 } })?.priceRange).toEqual({ minValue: 0, maxValue: 3495 });
  });
  it('leaves a series with real variation alone', () => {
    const range = { priceRange: { minValue: 100, maxValue: 150 } };
    expect(withZeroBaseline(range)).toBe(range);
  });
  it('passes through a missing range', () => {
    expect(withZeroBaseline(null)).toBeNull();
  });
});

describe('formatUsdAxis', () => {
  it('never shows a negative amount for a crosshair below the baseline', () => {
    expect(formatUsdAxis(-0.004)).toBe('$0.00');
    expect(formatUsdAxis(1500)).toBe('$1.5K');
  });
});
