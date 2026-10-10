import { describe, expect, it } from 'vitest';
import { CHART_RANGES, DEFAULT_CHART_RANGE, parseChartRange } from './ranges';

describe('chart ranges', () => {
  it('lists 1H, 1D, 1W, 1M and 1Y with 1D as the default', () => {
    expect(CHART_RANGES.map((range) => range.label)).toEqual(['1H', '1D', '1W', '1M', '1Y']);
    expect(DEFAULT_CHART_RANGE).toBe('1d');
  });
  it('falls back to the default for anything else', () => {
    expect(parseChartRange('1w')).toBe('1w');
    for (const bad of ['1D', '5m', '', undefined, null, 60]) expect(parseChartRange(bad)).toBe('1d');
  });
});
