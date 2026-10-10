'use client';

import { AreaSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PoolDayHistory } from '@/api/client';
import { formatUsdCompact } from '@/api/format';
import { RollingText } from '@/components/percent-change';

export type HistoryMetric = 'volume' | 'tvl';

const FALLBACK_GREEN = '#22c55e';
const DAY_SECONDS = 86_400;

function valueOf(item: PoolDayHistory, metric: HistoryMetric): string | null {
  return metric === 'volume' ? item.volumeUsd : item.tvlUsd;
}

// Total of every bucket in the window, or null when any bucket is unavailable (a partial sum would understate it).
export function windowTotal(items: readonly PoolDayHistory[]): string | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    if (item.volumeUsd === null) return null;
    total += Number(item.volumeUsd);
  }
  return Number.isFinite(total) ? String(total) : null;
}

export function latestTvl(items: readonly PoolDayHistory[]): PoolDayHistory | null {
  for (let index = items.length - 1; index >= 0; index -= 1) if (items[index]!.tvlUsd !== null) return items[index]!;
  return null;
}

// UTC, like the chart's own time axis.
export function formatBucketTime(time: number, intervalSeconds: number): string {
  return intervalSeconds >= DAY_SECONDS
    ? new Date(time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : new Date(time * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

export function windowLabel(seconds: number): string {
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds >= DAY_SECONDS) return plural(Math.round(seconds / DAY_SECONDS), 'day');
  if (seconds >= 3_600) return plural(Math.round(seconds / 3_600), 'hour');
  return plural(Math.round(seconds / 60), 'minute');
}

function stepOf(items: readonly PoolDayHistory[], intervalSeconds?: number): number {
  if (intervalSeconds) return intervalSeconds;
  return items.length > 1 ? items[1]!.day - items[0]!.day : DAY_SECONDS;
}

// Volume bars and TVL area for one launch or pool over the selected range. A bucket with no value is a gap in the
// series and reads "Unavailable" on hover — never a zero-height bar, which would claim a real $0.
export function PoolHistoryChart({ items, complete, metric, intervalSeconds, loading = false, error = false, headerClassName = 'text-2xl', leading, trailing }: {
  items: readonly PoolDayHistory[]; complete: boolean; metric: HistoryMetric; intervalSeconds?: number; loading?: boolean; error?: boolean; headerClassName?: string;
  /** Left of the bottom row (the range tabs); `trailing` is its right side (the chart-type tabs). */
  leading?: ReactNode; trailing?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | ISeriesApi<'Area'> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hovered, setHovered] = useState<PoolDayHistory | null>(null);
  const step = stepOf(items, intervalSeconds);
  const byTime = useMemo(() => new Map(items.map((item) => [item.day, item])), [items]);
  const byTimeRef = useRef(byTime);
  useEffect(() => { byTimeRef.current = byTime; }, [byTime]);
  const hasAny = items.some((item) => valueOf(item, metric) !== null);
  const showChart = hasAny && !loading && !error;

  // One chart per metric: a histogram for Volume, an area for TVL.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const green = getComputedStyle(container).getPropertyValue('--color-success').trim() || FALLBACK_GREEN;
    const chart = createChart(container, {
      autoSize: true,
      layout: { attributionLogo: true, background: { color: '#0a0a0b' }, textColor: '#a1a1aa' },
      grid: { vertLines: { visible: false }, horzLines: { color: '#18181b' } },
      rightPriceScale: { borderColor: '#27272a' },
      timeScale: { borderColor: '#27272a', timeVisible: step < DAY_SECONDS, secondsVisible: false },
      localization: { priceFormatter: (value: number) => formatUsdCompact(String(value), 2) },
    });
    const series = metric === 'volume'
      ? chart.addSeries(HistogramSeries, { color: green, priceFormat: { type: 'custom', formatter: (value: number) => formatUsdCompact(String(value), 2), minMove: 0.01 } })
      : chart.addSeries(AreaSeries, { lineColor: green, topColor: `${green}59`, bottomColor: `${green}00`, lineWidth: 2,
        priceFormat: { type: 'custom', formatter: (value: number) => formatUsdCompact(String(value), 2), minMove: 0.01 } });
    chartRef.current = chart;
    seriesRef.current = series;
    const onMove = (param: MouseEventParams<Time>) => setHovered(param.time === undefined ? null : byTimeRef.current.get(Number(param.time)) ?? null);
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [metric, step]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const points = items.map((item) => {
      const raw = valueOf(item, metric);
      return raw === null ? { time: item.day as UTCTimestamp } : { time: item.day as UTCTimestamp, value: Number(raw) };
    });
    (series as ISeriesApi<'Histogram'>).setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [items, metric, step]);

  const label = metric === 'volume' ? 'Volume' : 'TVL';
  const total = metric === 'volume' ? windowTotal(items) : null;
  const latest = metric === 'tvl' ? latestTvl(items) : null;
  const figure = hovered ? valueOf(hovered, metric) : metric === 'volume' ? total : latest?.tvlUsd ?? null;
  const caption = hovered
    ? formatBucketTime(hovered.day, step)
    : metric === 'volume' ? `Total, last ${windowLabel(items.length * step)}` : latest ? `Latest, ${formatBucketTime(latest.day, step)}` : 'No snapshot in this range';

  return (
    <section aria-label="Pool history">
      <div className="mb-2 min-h-20" data-testid="pool-history-readout">
        {!loading && !error && items.length > 0 && <>
          <p className={headerClassName}>
            {figure === null ? 'Unavailable' : <RollingText text={formatUsdCompact(figure, 2)} value={figure} flash />}
          </p>
          <p className="text-sm text-muted-foreground">{label} · {caption} <span className="text-xs">UTC</span></p>
        </>}
      </div>
      {loading && <div role="status" aria-label="Loading history" className="h-80 w-full animate-pulse rounded-lg bg-muted" />}
      {error && <p role="alert" className="flex h-80 items-center justify-center text-sm text-muted-foreground">Could not load this history.</p>}
      {!loading && !error && !hasAny && (
        <p role="status" className="flex h-80 items-center justify-center text-center text-sm text-muted-foreground">
          {metric === 'tvl' ? 'No TVL history recorded for this pool in this range.' : 'Volume history is unavailable.'}
        </p>
      )}
      <div ref={containerRef} role="img" aria-label={`${label} over the last ${windowLabel(items.length * step)}`} data-testid="history-chart-container"
        className={showChart ? 'h-80 w-full' : 'hidden'} onMouseLeave={() => setHovered(null)} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">{leading ?? <span />}{trailing}</div>
      {!complete && <p className="mt-2 text-xs text-muted-foreground">This pool is still being indexed, so earlier days may be incomplete.</p>}
    </section>
  );
}
