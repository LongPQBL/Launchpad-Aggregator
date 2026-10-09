'use client';

import { useState } from 'react';
import type { PoolDayHistory } from '@/api/client';
import { formatUsdCompact } from '@/api/format';
import { cn } from '@/lib/utils';

type Metric = 'volume' | 'tvl';

const METRICS: { metric: Metric; label: string }[] = [
  { metric: 'volume', label: 'Volume' },
  { metric: 'tvl', label: 'TVL' },
];

const BAR_AREA_HEIGHT = 120;
const BAR_WIDTH = 12;
const BAR_GAP = 4;

function valueOf(day: PoolDayHistory, metric: Metric): string | null {
  return metric === 'volume' ? day.volumeUsd : day.tvlUsd;
}

function dayLabel(day: number): string {
  return new Date(day * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Daily bars like Uniswap's pool Volume / TVL charts. A day with no value is drawn as an empty slot and
// labelled "unavailable" — never as a zero-height bar, which would claim a real $0.
export function PoolHistoryChart({ items, complete }: { items: readonly PoolDayHistory[]; complete: boolean }) {
  const [metric, setMetric] = useState<Metric>('volume');
  const [hovered, setHovered] = useState<PoolDayHistory | null>(null);

  const values = items.map((day) => valueOf(day, metric));
  const numeric = values.map((value) => (value === null ? null : Number(value)));
  const max = Math.max(0, ...numeric.filter((value): value is number => value !== null && Number.isFinite(value)));
  const hasAny = numeric.some((value) => value !== null);
  const width = items.length * (BAR_WIDTH + BAR_GAP);
  const shown = hovered ?? items.at(-1) ?? null;
  const shownValue = shown ? valueOf(shown, metric) : null;

  return (
    <section aria-label="Pool history" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="History metric" className="inline-flex gap-1 rounded-full bg-muted p-1">
          {METRICS.map((option) => (
            <button key={option.metric} type="button" role="tab" aria-selected={metric === option.metric} onClick={() => setMetric(option.metric)}
              className={cn('cursor-pointer rounded-full px-3 py-1 text-sm', metric === option.metric ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground')}>
              {option.label}
            </button>
          ))}
        </div>
        {shown && (
          <p className="text-sm" data-testid="pool-history-readout">
            <span className="text-muted-foreground">{dayLabel(shown.day)} · </span>
            <span className="font-semibold">{shownValue === null ? 'Unavailable' : formatUsdCompact(shownValue, 2)}</span>
          </p>
        )}
      </div>
      {hasAny ? (
        <svg role="img" aria-label={`Daily ${metric === 'volume' ? 'volume' : 'TVL'} for the last ${items.length} days`}
          viewBox={`0 0 ${width} ${BAR_AREA_HEIGHT}`} className="h-32 w-full" preserveAspectRatio="none" onMouseLeave={() => setHovered(null)}>
          {items.map((day, index) => {
            const value = numeric[index] ?? null;
            const x = index * (BAR_WIDTH + BAR_GAP);
            if (value === null) {
              return (
                <g key={day.day} onMouseEnter={() => setHovered(day)} data-testid="history-bar-unavailable">
                  <rect x={x} y={0} width={BAR_WIDTH} height={BAR_AREA_HEIGHT} fill="transparent" />
                  <rect x={x} y={BAR_AREA_HEIGHT - 2} width={BAR_WIDTH} height={2} className="fill-muted-foreground/30" />
                  <title>{`${dayLabel(day.day)}: unavailable`}</title>
                </g>
              );
            }
            const height = max > 0 ? Math.max(2, (value / max) * (BAR_AREA_HEIGHT - 4)) : 2;
            return (
              <g key={day.day} onMouseEnter={() => setHovered(day)} data-testid="history-bar">
                <rect x={x} y={0} width={BAR_WIDTH} height={BAR_AREA_HEIGHT} fill="transparent" />
                <rect x={x} y={BAR_AREA_HEIGHT - height} width={BAR_WIDTH} height={height} rx={2} className="fill-primary" />
                <title>{`${dayLabel(day.day)}: ${formatUsdCompact(String(value), 2)}`}</title>
              </g>
            );
          })}
        </svg>
      ) : (
        <p role="status" className="py-6 text-center text-sm text-muted-foreground">
          {metric === 'tvl' ? 'No TVL history recorded for this pool.' : 'Volume history is unavailable.'}
        </p>
      )}
      {!complete && <p className="text-xs text-muted-foreground">This pool is still being indexed, so earlier days may be incomplete.</p>}
      {metric === 'tvl' && <p className="text-xs text-muted-foreground">TVL is sampled hourly; only recent days are retained.</p>}
    </section>
  );
}
