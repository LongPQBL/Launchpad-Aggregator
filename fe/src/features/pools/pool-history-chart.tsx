'use client';

import { useState, type ReactNode } from 'react';
import type { PoolDayHistory } from '@/api/client';
import { formatUsdCompact } from '@/api/format';
import { RollingText } from '@/components/percent-change';

export type HistoryMetric = 'volume' | 'tvl';
type Metric = HistoryMetric;

const BAR_AREA_HEIGHT = 120;
const BAR_WIDTH = 12;
const BAR_GAP = 4;

function valueOf(day: PoolDayHistory, metric: Metric): string | null {
  return metric === 'volume' ? day.volumeUsd : day.tvlUsd;
}

function dayLabel(time: number, intervalSeconds = 86_400): string {
  return intervalSeconds >= 86_400
    ? new Date(time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : new Date(time * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

// Daily bars like Uniswap's pool Volume / TVL charts. A day with no value is drawn as an empty slot and
// labelled "unavailable" — never as a zero-height bar, which would claim a real $0.
export function PoolHistoryChart({ items, complete, metric, intervalSeconds = 86_400, loading = false, error = false, headerClassName = 'min-h-7 text-xl', leading, trailing }: {
  items: readonly PoolDayHistory[]; complete: boolean; metric: HistoryMetric; intervalSeconds?: number; loading?: boolean; error?: boolean; headerClassName?: string;
  /** Left of the bottom row (the interval tabs); `trailing` is its right side (the chart-type tabs). */
  leading?: ReactNode; trailing?: ReactNode;
}) {
  const [hovered, setHovered] = useState<PoolDayHistory | null>(null);

  const values = items.map((day) => valueOf(day, metric));
  const numeric = values.map((value) => (value === null ? null : Number(value)));
  const max = Math.max(0, ...numeric.filter((value): value is number => value !== null && Number.isFinite(value)));
  const hasAny = numeric.some((value) => value !== null);
  const width = items.length * (BAR_WIDTH + BAR_GAP);
  const shown = hovered ?? items.at(-1) ?? null;
  const shownValue = shown ? valueOf(shown, metric) : null;

  return (
    <section aria-label="Pool history">
      {/* Same heights as the price chart's header and chart area, so switching chart type does not move the page.
          mb-5 = the price chart's header gap (mb-2) plus its toggle row gap (mb-3); two separate margins would collapse. */}
      <p className={`mb-5 ${headerClassName}`} data-testid="pool-history-readout">
        {!loading && shown && <>
          <span className="text-muted-foreground"><RollingText text={dayLabel(shown.day, intervalSeconds)} /> · </span>
          <span>{shownValue === null ? 'Unavailable' : <RollingText text={formatUsdCompact(shownValue, 2)} value={shownValue} flash />}</span>
        </>}
      </p>
      {loading ? (
        <div role="status" aria-label="Loading history" className="h-80 w-full animate-pulse rounded-lg bg-muted" />
      ) : error ? (
        <p role="alert" className="flex h-80 items-center justify-center text-sm text-muted-foreground">Could not load this history.</p>
      ) : hasAny ? (
        <svg role="img" aria-label={`Daily ${metric === 'volume' ? 'volume' : 'TVL'} for the last ${items.length} ${intervalSeconds >= 86_400 ? 'days' : 'intervals'}`}
          viewBox={`0 0 ${width} ${BAR_AREA_HEIGHT}`} className="h-80 w-full" preserveAspectRatio="none" onMouseLeave={() => setHovered(null)}>
          {items.map((day, index) => {
            const value = numeric[index] ?? null;
            const x = index * (BAR_WIDTH + BAR_GAP);
            if (value === null) {
              return (
                <g key={day.day} onMouseEnter={() => setHovered(day)} data-testid="history-bar-unavailable">
                  <rect x={x} y={0} width={BAR_WIDTH} height={BAR_AREA_HEIGHT} fill="transparent" />
                  <rect x={x} y={BAR_AREA_HEIGHT - 2} width={BAR_WIDTH} height={2} className="fill-muted-foreground/30" />
                  <title>{`${dayLabel(day.day, intervalSeconds)}: unavailable`}</title>
                </g>
              );
            }
            const height = max > 0 ? Math.max(2, (value / max) * (BAR_AREA_HEIGHT - 4)) : 2;
            return (
              <g key={day.day} onMouseEnter={() => setHovered(day)} data-testid="history-bar">
                <rect x={x} y={0} width={BAR_WIDTH} height={BAR_AREA_HEIGHT} fill="transparent" />
                <rect x={x} y={BAR_AREA_HEIGHT - height} width={BAR_WIDTH} height={height} rx={2} className="fill-primary" />
                <title>{`${dayLabel(day.day, intervalSeconds)}: ${formatUsdCompact(String(value), 2)}`}</title>
              </g>
            );
          })}
        </svg>
      ) : (
        <p role="status" className="flex h-80 items-center justify-center text-center text-sm text-muted-foreground">
          {metric === 'tvl' ? 'No TVL history recorded for this pool.' : 'Volume history is unavailable.'}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">{leading ?? <span />}{trailing}</div>
      {!complete && <p className="mt-2 text-xs text-muted-foreground">This pool is still being indexed, so earlier days may be incomplete.</p>}
    </section>
  );
}
