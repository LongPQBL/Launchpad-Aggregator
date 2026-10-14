import { describe, expect, it } from 'vitest';
import { rangeSlots, withWhitespace } from './ranges';

describe('range time slots', () => {
  const now = 1_800_000_000;
  it('has one slot per bucket from the start of the window to now', () => {
    const slots = rangeSlots('1d', now)!;
    expect(slots.at(-1)).toBe(Math.floor(now / 300) * 300);
    expect(slots.at(-1)! - slots[0]!).toBeGreaterThanOrEqual(86_400);
    expect(slots.every((time, index) => index === 0 || time - slots[index - 1]! === 300)).toBe(true);
  });
  it('has no fixed window for All', () => {
    expect(rangeSlots('all', now)).toBeNull();
  });
  it('keeps real points and only adds empty points for the slots without one', () => {
    const real = { time: Math.floor(now / 60) * 60 - 600, value: 5 };
    const merged = withWhitespace([real], '1h', now);
    expect(merged.filter((point) => 'value' in point)).toEqual([real]);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged.every((point, index) => index === 0 || point.time > merged[index - 1]!.time)).toBe(true);
  });
  it('starts a little before the first real point, not at the start of a 24-hour window, so the candles stay wide', () => {
    const real = { time: Math.floor(now / 300) * 300 - 3_600, value: 5 }; // trading started an hour ago
    const merged = withWhitespace([real], '1d', now);
    expect(merged[0]!.time).toBeGreaterThanOrEqual(real.time - 5_000); // a few slots of padding, not 24 hours
    expect(merged.length).toBeLessThan(40);
    expect(merged.at(-1)!.time).toBe(Math.floor(now / 300) * 300);
  });
  it('fills the whole window when there is no real point', () => {
    expect(withWhitespace([], '1d', now).length).toBe(rangeSlots('1d', now)!.length);
  });
  it('leaves the points alone for All', () => {
    const points = [{ time: 1, value: 1 }];
    expect(withWhitespace(points, 'all', now)).toEqual(points);
  });
});
