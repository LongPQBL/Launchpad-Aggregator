import { describe, expect, it } from 'vitest';
import {
  computeChartPrecision,
  formatActivityKind,
  formatLifecycleStatus,
  formatQuote,
  formatSide,
  formatVenueKind,
  toChartValue,
} from './format';

describe('formatQuote', () => {
  it('shows the raw decimal string with its symbol when a value is available', () => {
    expect(formatQuote('12.5', 'ROBIN')).toBe('12.5 ROBIN');
  });

  it('shows "Chưa có dữ liệu" instead of a fabricated zero when the value is null', () => {
    expect(formatQuote(null, 'ROBIN')).toBe('Chưa có dữ liệu');
  });

  it('keeps the exact decimal string for a 6-decimal ERC-20 amount, without rounding', () => {
    expect(formatQuote('123.456789', 'USDC')).toBe('123.456789 USDC');
  });
});

describe('formatSide', () => {
  it('labels a buy as "Mua"', () => {
    expect(formatSide('buy')).toBe('Mua');
  });

  it('labels a sell as "Bán"', () => {
    expect(formatSide('sell')).toBe('Bán');
  });
});

describe('formatActivityKind', () => {
  it('labels a protocol buyback as done by Pons, not the user', () => {
    expect(formatActivityKind('protocol_buyback')).toBe('Buyback bởi Pons');
  });

  it('labels a protocol fee conversion as done by Pons, not the user', () => {
    expect(formatActivityKind('protocol_fee_conversion')).toBe('Đổi phí bởi Pons');
  });

  it('labels an unattributed protocol swap neutrally, without guessing it is a buyback', () => {
    expect(formatActivityKind('protocol_internal')).toBe('Giao dịch nội bộ Pons');
  });

  it('returns null for an ordinary user trade so callers fall back to the buy/sell side label', () => {
    expect(formatActivityKind('user_trade')).toBeNull();
  });
});

describe('formatLifecycleStatus', () => {
  it('labels the swept phase', () => {
    expect(formatLifecycleStatus('swept')).toBe('Đã gom (Swept)');
  });

  it('labels the rescued phase', () => {
    expect(formatLifecycleStatus('rescued')).toBe('Đã cứu hộ (Rescued)');
  });
});

describe('formatVenueKind', () => {
  it('labels the bonding curve venue', () => {
    expect(formatVenueKind('curve')).toBe('Bonding curve');
  });

  it('labels the V4 pool venue', () => {
    expect(formatVenueKind('v4_pool')).toBe('Pool Uniswap V4');
  });
});

describe('toChartValue', () => {
  it('parses a normalized decimal string into the number Lightweight Charts needs, at the render boundary only', () => {
    expect(toChartValue('0.000000152480063034')).toBeCloseTo(0.000000152480063034, 18);
  });
});

describe('computeChartPrecision', () => {
  it('uses enough decimal digits that a pons-scale sub-cent price is not rounded to 0.00', () => {
    const { precision, minMove } = computeChartPrecision(['0.000000152', '0.000000160', '0.000000140']);

    expect(precision).toBeGreaterThanOrEqual(8);
    expect(minMove).toBeLessThanOrEqual(1e-8);
  });

  it('falls back to the default 2-decimal precision for prices at or above 1', () => {
    expect(computeChartPrecision(['1.5', '2.25'])).toEqual({ precision: 2, minMove: 0.01 });
  });

  it('falls back to the default precision when given no values', () => {
    expect(computeChartPrecision([])).toEqual({ precision: 2, minMove: 0.01 });
  });
});
