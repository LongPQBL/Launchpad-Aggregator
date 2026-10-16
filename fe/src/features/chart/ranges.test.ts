import { describe, expect, it } from 'vitest';
import { DEFAULT_CHART_RANGE, defaultRangeFor, parseChartRange, rangeIsForStyle, rangesForStyle, rangeSlots, withWhitespace } from './ranges';

describe('tabs per chart style', () => {
  it('keeps the candle-size tabs for candles and uses Uniswap-style spans of time for the line', () => {
    expect(rangesForStyle('candles').map((item) => item.label)).toEqual(['1m', '5m', '1H', '4H', '1D']);
    expect(rangesForStyle('line').map((item) => [item.id, item.label])).toEqual([['w1h', '1H'], ['w1d', '1D'], ['w1w', '1W'], ['w1m', '1M'], ['w1y', '1Y']]);
  });
  it('defaults to 1H candles and a one-day line', () => {
    expect(DEFAULT_CHART_RANGE).toBe('1h');
    expect(defaultRangeFor('candles')).toBe('1h');
    expect(defaultRangeFor('line')).toBe('w1d');
  });
  it('knows which style a range belongs to and parses the line ids from a URL', () => {
    expect(rangeIsForStyle('4h', 'candles')).toBe(true);
    expect(rangeIsForStyle('4h', 'line')).toBe(false);
    expect(rangeIsForStyle('w1w', 'line')).toBe(true);
    expect(rangeIsForStyle('w1w', 'candles')).toBe(false);
    expect(parseChartRange('w1m')).toBe('w1m');
    expect(parseChartRange('w1x')).toBe(DEFAULT_CHART_RANGE);
  });
  it('spaces a line tab by its own bar size', () => {
    const now = 1_800_000_000;
    const slots = rangeSlots('w1w', now);
    expect(slots.at(-1)).toBe(Math.floor(now / 3_600) * 3_600);
    expect(slots.at(-1)! - slots[0]!).toBeGreaterThanOrEqual(7 * 86_400);
    expect(slots[1]! - slots[0]!).toBe(3_600);
  });
});

describe('range time slots', () => {
  const now = 1_800_000_000;
  it('has one slot per bucket from the start of the window to now', () => {
    const slots = rangeSlots('5m', now);
    expect(slots.at(-1)).toBe(Math.floor(now / 300) * 300);
    expect(slots.at(-1)! - slots[0]!).toBeGreaterThanOrEqual(43_200);
    expect(slots.every((time, index) => index === 0 || time - slots[index - 1]! === 300)).toBe(true);
  });
  it('keeps real points and only adds empty points for the slots without one', () => {
    const real = { time: Math.floor(now / 60) * 60 - 600, value: 5 };
    const merged = withWhitespace([real], '1m', now);
    expect(merged.filter((point) => 'value' in point)).toEqual([real]);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged.every((point, index) => index === 0 || point.time > merged[index - 1]!.time)).toBe(true);
  });
  it('starts a little before the first real point, not at the start of the whole window, so the candles stay wide', () => {
    const real = { time: Math.floor(now / 300) * 300 - 3_600, value: 5 }; // trading started an hour ago
    const merged = withWhitespace([real], '5m', now);
    expect(merged[0]!.time).toBeGreaterThanOrEqual(real.time - 5_000); // a few slots of padding, not 12 hours
    expect(merged.length).toBeLessThan(40);
    expect(merged.at(-1)!.time).toBe(Math.floor(now / 300) * 300);
  });
  it('fills the whole window when there is no real point', () => {
    expect(withWhitespace([], '5m', now).length).toBe(rangeSlots('5m', now).length);
  });
});
