// The chart tabs are time ranges; the server decides the bucket size for each (be/src/charts/ranges.ts).
export const CHART_RANGES = [
  { id: '1h', label: '1H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '1y', label: '1Y' },
  { id: 'all', label: 'All' },
] as const;
export type ChartRangeId = (typeof CHART_RANGES)[number]['id'];
export const DEFAULT_CHART_RANGE: ChartRangeId = '1d';

export function parseChartRange(value: unknown): ChartRangeId {
  return CHART_RANGES.some((range) => range.id === value) ? (value as ChartRangeId) : DEFAULT_CHART_RANGE;
}

// Window and bucket size of each range, mirroring be/src/charts/ranges.ts (the server decides the real ones; these only space the time axis).
const WINDOWS: Partial<Record<ChartRangeId, { windowSeconds: number; intervalSeconds: number }>> = {
  '1h': { windowSeconds: 3_600, intervalSeconds: 60 },
  '1d': { windowSeconds: 86_400, intervalSeconds: 300 },
  '1w': { windowSeconds: 604_800, intervalSeconds: 3_600 },
  '1m': { windowSeconds: 2_592_000, intervalSeconds: 14_400 },
  '1y': { windowSeconds: 31_536_000, intervalSeconds: 86_400 },
};

/**
 * Time slots from the start of the range's window to now, one per bucket. A price chart places bars by index, so a quiet stretch
 * would collapse and the axis would only be labelled where trades happened; adding an empty (whitespace) point for every slot keeps
 * the axis true to time. Returns null for a range with no fixed window ("All").
 */
export function rangeSlots(range: ChartRangeId, nowSeconds: number): number[] | null {
  const spec = WINDOWS[range];
  if (!spec) return null;
  const last = Math.floor(nowSeconds / spec.intervalSeconds) * spec.intervalSeconds;
  const first = Math.floor((nowSeconds - spec.windowSeconds) / spec.intervalSeconds) * spec.intervalSeconds;
  const slots: number[] = [];
  for (let time = first; time <= last; time += spec.intervalSeconds) slots.push(time);
  return slots;
}

/** The real points plus an empty point for every slot of the range that has none, in time order. */
export function withWhitespace<T extends { time: number }>(points: readonly T[], range: ChartRangeId, nowSeconds: number): Array<T | { time: number }> {
  const slots = rangeSlots(range, nowSeconds);
  if (!slots) return [...points];
  const known = new Set(points.map((point) => point.time));
  const merged: Array<T | { time: number }> = [...points, ...slots.filter((time) => !known.has(time)).map((time) => ({ time }))];
  return merged.sort((a, b) => a.time - b.time);
}
