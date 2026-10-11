import { describe, expect, it } from 'vitest';
import { CHART_KINDS } from './chart-kinds';

describe('CHART_KINDS', () => {
  it('uses a range only for the time-based kinds, and a line / candle style only for Price', () => {
    expect(Object.entries(CHART_KINDS).filter(([, spec]) => spec.usesRange).map(([kind]) => kind)).toEqual(['price', 'volume', 'tvl']);
    expect(Object.entries(CHART_KINDS).filter(([, spec]) => spec.usesChartStyle).map(([kind]) => kind)).toEqual(['price']);
  });
  it('labels every kind', () => {
    expect(Object.values(CHART_KINDS).map((spec) => spec.label)).toEqual(['Price', 'Volume', 'TVL', 'Liquidity', 'Depth']);
  });
});
