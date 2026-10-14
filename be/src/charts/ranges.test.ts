import { describe, expect, it } from 'vitest';
import { CHART_RANGES, DEFAULT_RANGE, historyTtlMs, parseRange, rangeSpec, trimToRange } from './ranges.js';

describe('chart ranges', () => {
  it('maps each tab to the size of one bar and a fixed number of bars', () => {
    expect(rangeSpec('1m')).toEqual({ windowSeconds: 7_200, intervalSeconds: 60, buckets: 120 });
    expect(rangeSpec('5m')).toEqual({ windowSeconds: 43_200, intervalSeconds: 300, buckets: 144 });
    expect(rangeSpec('1h')).toEqual({ windowSeconds: 604_800, intervalSeconds: 3_600, buckets: 168 });
    expect(rangeSpec('4h')).toEqual({ windowSeconds: 2_592_000, intervalSeconds: 14_400, buckets: 180 });
    expect(rangeSpec('1d')).toEqual({ windowSeconds: 31_536_000, intervalSeconds: 86_400, buckets: 365 });
  });

  it('defaults to 1h and lists every tab', () => {
    expect(DEFAULT_RANGE).toBe('1h');
    expect(CHART_RANGES).toEqual(['1m', '5m', '1h', '4h', '1d']);
  });

  it('parses only exact tab ids (the old range ids are gone)', () => {
    expect(parseRange('4h')).toBe('4h');
    for (const bad of ['1D', '', undefined, null, '1w', '1y', 'all', 7]) expect(parseRange(bad)).toBeNull();
  });

  it('trims candles to the window including the bucket it starts in, keeping order', () => {
    const now = 100_000;
    const items = [{ bucketStart: 99_960 }, { bucketStart: 96_420 }, { bucketStart: 96_360 }, { bucketStart: 10 }];
    // 1m window (120 bars of 60 s): oldest bucket start is floor((100000 - 7200) / 60) * 60 = 92,760
    expect(trimToRange(items, '1m', now)).toEqual([{ bucketStart: 99_960 }, { bucketStart: 96_420 }, { bucketStart: 96_360 }]);
  });

  it('caches fine buckets briefly and coarse ones longer', () => {
    expect(historyTtlMs(60)).toBeLessThan(historyTtlMs(300));
    expect(historyTtlMs(300)).toBeLessThan(historyTtlMs(3_600));
    expect(historyTtlMs(3_600)).toBeLessThan(historyTtlMs(86_400));
  });
});
