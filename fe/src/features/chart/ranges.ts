// The chart tabs are time ranges; the server decides the bucket size for each (be/src/charts/ranges.ts).
export const CHART_RANGES = [
  { id: '1h', label: '1H' },
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '1y', label: '1Y' },
] as const;
export type ChartRangeId = (typeof CHART_RANGES)[number]['id'];
export const DEFAULT_CHART_RANGE: ChartRangeId = '1d';

export function parseChartRange(value: unknown): ChartRangeId {
  return CHART_RANGES.some((range) => range.id === value) ? (value as ChartRangeId) : DEFAULT_CHART_RANGE;
}
