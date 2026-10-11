'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts';

const BACKGROUND = '#0a0a0b';
const GREEN = 'var(--color-success, #22c55e)';

// The chart canvas is transparent, so this dotted backdrop shows through behind the series.
export const DOTTED_BACKGROUND_STYLE: CSSProperties = {
  backgroundColor: BACKGROUND,
  backgroundImage: 'radial-gradient(circle, #27272a 1px, transparent 1.2px)',
  backgroundSize: '14px 14px',
};

/** The left edge of the chart fades into the page instead of being cut off. */
export function ChartLeftFade() {
  return <div aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 48, pointerEvents: 'none', zIndex: 2,
    background: `linear-gradient(to right, ${BACKGROUND}, transparent)` }} />;
}

/** Tints everything to the right of the pointer, so the line reads as "up to here" while scrubbing. */
export function ChartDimAfter({ x }: { x: number | null }) {
  if (x === null) return null;
  return <div aria-hidden="true" data-testid="chart-dim" style={{ position: 'absolute', left: x, top: 0, bottom: 0, right: 0, pointerEvents: 'none', zIndex: 3,
    background: 'rgba(10, 10, 11, 0.55)' }} />;
}

const PING_KEYFRAMES = `@keyframes chart-live-ping { 0% { transform: scale(1); opacity: 0.6; } 80%, 100% { transform: scale(3.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .chart-live-ping { animation: none !important; } }`;

/**
 * A pulsing dot on the newest point of a line / area series. The chart library has no such marker, so the dot is an overlay
 * placed from the series' own coordinates; it follows zoom, pan, resize and a rescaled price axis (it re-reads every frame,
 * only re-rendering when the position actually changes) and hides when the point is outside the visible plot.
 */
export function ChartLiveDot({ chart, series, point, color = GREEN }: {
  chart: IChartApi | null; series: ISeriesApi<SeriesType> | null; point: { time: number; value: number } | null;
  /** The series' own line color, so the dot matches it. */
  color?: string;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const time = point?.time;
  const value = point?.value;
  useEffect(() => {
    if (!chart || !series || time === undefined || value === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no point to mark: remove the dot
      setPosition(null);
      return;
    }
    let frame = 0;
    const update = () => {
      let next: { x: number; y: number } | null = null;
      try {
        const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
        const y = series.priceToCoordinate(value);
        if (typeof x === 'number' && typeof y === 'number' && x >= 0 && y >= 0 && x <= chart.timeScale().width() && y <= chart.paneSize().height) next = { x, y };
      } catch { next = null; }
      setPosition((previous) => (previous?.x === next?.x && previous?.y === next?.y ? previous : next));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [chart, series, time, value]);

  if (!position) return null;
  return (
    <>
      <style>{PING_KEYFRAMES}</style>
      <span aria-hidden="true" data-testid="chart-live-dot" style={{ position: 'absolute', left: position.x - 5, top: position.y - 5, width: 10, height: 10, pointerEvents: 'none', zIndex: 4 }}>
        <span className="chart-live-ping" style={{ position: 'absolute', inset: 0, borderRadius: 9999, background: color, animation: 'chart-live-ping 1.8s ease-out infinite' }} />
        <span style={{ position: 'absolute', inset: 0, borderRadius: 9999, background: color, border: `2px solid ${BACKGROUND}`,
          boxShadow: `0 0 8px 2px color-mix(in srgb, ${color} 55%, transparent)` }} />
      </span>
    </>
  );
}

export interface OhlcHover { x: number; y: number; width: number; open: number; high: number; low: number; close: number }

/** Open / High / Low / Close of the candle under the pointer, in a small box beside it (flips to the left near the right edge). */
export function ChartOhlcTooltip({ hover, format }: { hover: OhlcHover | null; format: (value: number) => string }) {
  if (hover === null) return null;
  const boxWidth = 150;
  const left = hover.x + 16 + boxWidth > hover.width ? hover.x - 16 - boxWidth : hover.x + 16;
  return (
    <div role="tooltip" data-testid="chart-ohlc-tooltip" style={{ position: 'absolute', left, top: Math.max(4, hover.y - 40), width: boxWidth, pointerEvents: 'none', zIndex: 5,
      background: 'rgba(24, 24, 27, 0.95)', border: '1px solid #3f3f46', borderRadius: 8, padding: '6px 10px', fontSize: 12, lineHeight: '18px' }}>
      {([['Open', hover.open], ['High', hover.high], ['Low', hover.low], ['Close', hover.close]] as const).map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#a1a1aa' }}>{label}</span><span>{format(value)}</span>
        </div>
      ))}
    </div>
  );
}

/** A translucent column over the bar under the pointer, like Uniswap's Volume chart. `x` is the bar's center, `width` the column width. */
export function ChartBarHighlight({ x, width }: { x: number | null; width: number }) {
  if (x === null) return null;
  return <div aria-hidden="true" data-testid="chart-bar-highlight" style={{ position: 'absolute', left: x - width / 2, width, top: 0, bottom: 0, pointerEvents: 'none', zIndex: 1,
    background: 'rgba(255, 255, 255, 0.18)' }} />;
}
