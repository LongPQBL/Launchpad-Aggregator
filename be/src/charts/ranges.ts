export const CHART_RANGES = ['1h', '1d', '1w', '1m', '1y', 'all'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const DEFAULT_RANGE: ChartRange = '1d';

// The one place that decides how much time a chart tab shows and how coarse its buckets are.
const SPECS = {
  '1h': { windowSeconds: 3_600, intervalSeconds: 60 },
  '1d': { windowSeconds: 86_400, intervalSeconds: 300 },
  '1w': { windowSeconds: 604_800, intervalSeconds: 3_600 },
  '1m': { windowSeconds: 2_592_000, intervalSeconds: 14_400 },
  '1y': { windowSeconds: 31_536_000, intervalSeconds: 86_400 },
  // Everything the history endpoints can serve: daily buckets up to their bucket cap (400 days). The client drops the empty days before the first data.
  all: { windowSeconds: 400 * 86_400, intervalSeconds: 86_400 },
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
