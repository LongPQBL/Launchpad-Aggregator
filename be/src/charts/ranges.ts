// A chart tab names the size of one candle / bar (1m, 5m, 1h, 4h, 1d), like TradingView and DexScreener; the window is a fixed number of those
// bars ending now. (The query parameter keeps its old name, `range`.)
export const CHART_RANGES = ['1m', '5m', '1h', '4h', '1d'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const DEFAULT_RANGE: ChartRange = '1h';

// The one place that decides how many bars a chart tab shows.
const SPECS = {
  '1m': { windowSeconds: 120 * 60, intervalSeconds: 60 },
  '5m': { windowSeconds: 144 * 300, intervalSeconds: 300 },
  '1h': { windowSeconds: 168 * 3_600, intervalSeconds: 3_600 },
  '4h': { windowSeconds: 180 * 14_400, intervalSeconds: 14_400 },
  '1d': { windowSeconds: 365 * 86_400, intervalSeconds: 86_400 },
} as const;

export function parseRange(value: unknown): ChartRange | null {
  return typeof value === 'string' && (CHART_RANGES as readonly string[]).includes(value) ? (value as ChartRange) : null;
}

export function rangeSpec(range: ChartRange): { windowSeconds: number; intervalSeconds: number; buckets: number } {
  const spec = SPECS[range];
  return { ...spec, buckets: spec.windowSeconds / spec.intervalSeconds };
}

/** Keeps the candles that fall inside the range's window (including the bucket the window starts in). Order is preserved. */
export function trimToRange<T extends { bucketStart: number }>(items: readonly T[], range: ChartRange, nowSeconds: number): T[] {
  const { windowSeconds, intervalSeconds } = rangeSpec(range);
  const oldest = Math.floor((nowSeconds - windowSeconds) / intervalSeconds) * intervalSeconds;
  return items.filter((item) => item.bucketStart >= oldest);
}

/** How long a history answer for this bucket size may be reused: fine buckets change fast, coarse ones slowly. */
export function historyTtlMs(intervalSeconds: number): number {
  if (intervalSeconds <= 60) return 5_000;
  if (intervalSeconds <= 300) return 15_000;
  if (intervalSeconds <= 3_600) return 60_000;
  return 300_000;
}
