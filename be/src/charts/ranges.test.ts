import { describe, expect, it } from 'vitest';
import { CHART_RANGES, DEFAULT_RANGE, historyTtlMs, parseRange, rangeSpec, trimToRange } from './ranges.js';

describe('chart ranges', () => {
  it('maps each range to its window and bucket', () => {
    expect(rangeSpec('1h')).toEqual({ windowSeconds: 3_600, intervalSeconds: 60, buckets: 60 });
    expect(rangeSpec('1d')).toEqual({ windowSeconds: 86_400, intervalSeconds: 300, buckets: 288 });
    expect(rangeSpec('1w')).toEqual({ windowSeconds: 604_800, intervalSeconds: 3_600, buckets: 168 });
    expect(rangeSpec('1m')).toEqual({ windowSeconds: 2_592_000, intervalSeconds: 14_400, buckets: 180 });
    expect(rangeSpec('1y')).toEqual({ windowSeconds: 31_536_000, intervalSeconds: 86_400, buckets: 365 });
  });

  it('defaults to 1d and lists every range', () => {
    expect(DEFAULT_RANGE).toBe('1d');
    expect(CHART_RANGES).toEqual(['1h', '1d', '1w', '1m', '1y']);
  });

  it('parses only exact range ids', () => {
    expect(parseRange('1w')).toBe('1w');
    for (const bad of ['1D', '', undefined, null, '5m', 7]) expect(parseRange(bad)).toBeNull();
  });

  it('trims candles to the window including the bucket it starts in, keeping order', () => {
    const now = 100_000;
    const items = [{ bucketStart: 99_960 }, { bucketStart: 96_420 }, { bucketStart: 96_360 }, { bucketStart: 10 }];
    // 1h window at 60 s buckets: oldest bucket start is floor((100000 - 3600) / 60) * 60 = 96,360
    expect(trimToRange(items, '1h', now)).toEqual([{ bucketStart: 99_960 }, { bucketStart: 96_420 }, { bucketStart: 96_360 }]);
  });

  it('caches fine buckets briefly and coarse ones longer', () => {
    expect(historyTtlMs(60)).toBeLessThan(historyTtlMs(300));
    expect(historyTtlMs(300)).toBeLessThan(historyTtlMs(3_600));
    expect(historyTtlMs(3_600)).toBeLessThan(historyTtlMs(86_400));
  });
});
