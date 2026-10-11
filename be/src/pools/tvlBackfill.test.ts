import { describe, expect, it } from 'vitest';
import { buildGrid } from './tvlBackfill.js';

describe('buildGrid', () => {
  const now = 1_800_000_000 + 1234; // not on a bucket boundary
  it('covers only fully ended buckets, sampled at their last second, sorted by time', () => {
    const grid = buildGrid(now, 400);
    expect(grid.every((point) => point.sampleAt === point.bucketStart + point.interval - 1 && point.sampleAt <= now)).toBe(true);
    expect(grid.every((point, index) => index === 0 || grid[index - 1]!.sampleAt <= point.sampleAt)).toBe(true);
  });
  it('uses the hourly window for 7 days, 4-hour for 30 days and daily for the whole range', () => {
    const grid = buildGrid(now, 100);
    const count = (interval: number) => grid.filter((point) => point.interval === interval).length;
    expect(count(3600)).toBeGreaterThanOrEqual(167);
    expect(count(3600)).toBeLessThanOrEqual(168);
    expect(count(14_400)).toBeGreaterThanOrEqual(179);
    expect(count(14_400)).toBeLessThanOrEqual(180);
    expect(count(86_400)).toBeGreaterThanOrEqual(99);
    expect(count(86_400)).toBeLessThanOrEqual(100);
  });
  it('shrinks every window to the requested number of days', () => {
    expect(buildGrid(now, 2).filter((point) => point.interval === 3600).length).toBeLessThanOrEqual(48);
  });
});
