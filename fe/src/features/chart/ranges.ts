// A chart tab names the size of one candle / bar, as on TradingView and DexScreener (1D = one bar per day); the server shows a fixed number of
// bars ending now (be/src/charts/ranges.ts). Ids keep the old "range" name in URLs and code.
export const CHART_RANGES = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1d', label: '1D' },
] as const;
export const LINE_RANGES = [
  { id: 'w1h', label: '1H' },
  { id: 'w1d', label: '1D' },
  { id: 'w1w', label: '1W' },
  { id: 'w1m', label: '1M' },
  { id: 'w1y', label: '1Y' },
] as const;
export type ChartRangeId = (typeof CHART_RANGES)[number]['id'] | (typeof LINE_RANGES)[number]['id'];
export type ChartRangeStyle = 'candles' | 'line';
export const DEFAULT_CHART_RANGE: ChartRangeId = '1h';

export function rangesForStyle(style: ChartRangeStyle): ReadonlyArray<{ id: ChartRangeId; label: string }> {
  return style === 'line' ? LINE_RANGES : CHART_RANGES;
}

export function defaultRangeFor(style: ChartRangeStyle): ChartRangeId {
  return style === 'line' ? 'w1d' : DEFAULT_CHART_RANGE;
}

export function rangeIsForStyle(range: ChartRangeId, style: ChartRangeStyle): boolean {
  return rangesForStyle(style).some((item) => item.id === range);
}

export function parseChartRange(value: unknown): ChartRangeId {
  return [...CHART_RANGES, ...LINE_RANGES].some((range) => range.id === value) ? (value as ChartRangeId) : DEFAULT_CHART_RANGE;
}

/** Bars of a day or more are labelled with dates only; shorter ones also show the time of day. */
export function rangeShowsTime(range: ChartRangeId): boolean {
  return WINDOWS[range].intervalSeconds < 86_400;
}

// Window and bar size of each tab, mirroring be/src/charts/ranges.ts (the server decides the real ones; these only space the time axis).
const WINDOWS: Record<ChartRangeId, { windowSeconds: number; intervalSeconds: number }> = {
  '1m': { windowSeconds: 120 * 60, intervalSeconds: 60 },
  '5m': { windowSeconds: 144 * 300, intervalSeconds: 300 },
  '1h': { windowSeconds: 168 * 3_600, intervalSeconds: 3_600 },
  '4h': { windowSeconds: 180 * 14_400, intervalSeconds: 14_400 },
  '1d': { windowSeconds: 365 * 86_400, intervalSeconds: 86_400 },
  w1h: { windowSeconds: 3_600, intervalSeconds: 60 },
  w1d: { windowSeconds: 86_400, intervalSeconds: 300 },
  w1w: { windowSeconds: 7 * 86_400, intervalSeconds: 3_600 },
  w1m: { windowSeconds: 30 * 86_400, intervalSeconds: 14_400 },
  w1y: { windowSeconds: 365 * 86_400, intervalSeconds: 86_400 },
};

/**
 * Time slots from the start of the range's window to now, one per bucket. A price chart places bars by index, so a quiet stretch
 * would collapse and the axis would only be labelled where trades happened; adding an empty (whitespace) point for every slot keeps
 * the axis true to time. 
 */
export function rangeSlots(range: ChartRangeId, nowSeconds: number): number[] {
  const spec = WINDOWS[range];
  const last = Math.floor(nowSeconds / spec.intervalSeconds) * spec.intervalSeconds;
  const first = Math.floor((nowSeconds - spec.windowSeconds) / spec.intervalSeconds) * spec.intervalSeconds;
  const slots: number[] = [];
  for (let time = first; time <= last; time += spec.intervalSeconds) slots.push(time);
  return slots;
}

/**
 * The real points plus an empty point for every slot between a little before the first real point and now, in time order, so the
 * time axis stays true to time (a quiet stretch keeps its width) while the candles of a token that only just started trading are not
 * squeezed into a corner of a 24-hour window. With no real point the whole window is filled (an empty chart).
 */
export function withWhitespace<T extends { time: number }>(points: readonly T[], range: ChartRangeId, nowSeconds: number): Array<T | { time: number }> {
  const slots = rangeSlots(range, nowSeconds);
  const first = points.reduce((min, point) => Math.min(min, point.time), Infinity);
  const spacing = slots.length > 1 ? slots[1]! - slots[0]! : 1;
  const padding = Math.max(6, Math.ceil(slots.length * 0.05)) * spacing;
  const wanted = Number.isFinite(first) ? slots.filter((time) => time >= first - padding) : slots;
  const known = new Set(points.map((point) => point.time));
  const merged: Array<T | { time: number }> = [...points, ...wanted.filter((time) => !known.has(time)).map((time) => ({ time }))];
  return merged.sort((a, b) => a.time - b.time);
}
