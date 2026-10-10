export const CHART_RANGES = ['1h', '1d', '1w', '1m', '1y'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const DEFAULT_RANGE: ChartRange = '1d';

// The one place that decides how much time a chart tab shows and how coarse its buckets are.
const SPECS = {
  '1h': { windowSeconds: 3_600, intervalSeconds: 60 },
  '1d': { windowSeconds: 86_400, intervalSeconds: 300 },
  '1w': { windowSeconds: 604_800, intervalSeconds: 3_600 },
  '1m': { windowSeconds: 2_592_000, intervalSeconds: 14_400 },
  '1y': { windowSeconds: 31_536_000, intervalSeconds: 86_400 },
} as const;

export function parseRange(value: unknown): ChartRange | null {
  return typeof value === 'string' && (CHART_RANGES as readonly string[]).includes(value) ? (value as ChartRange) : null;
}

export function rangeSpec(range: ChartRange): { windowSeconds: number; intervalSeconds: number; buckets: number } {
  const spec = SPECS[range];
  return { ...spec, buckets: spec.windowSeconds / spec.intervalSeconds };
}
