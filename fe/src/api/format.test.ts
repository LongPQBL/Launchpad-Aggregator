import { describe, expect, it } from 'vitest';
import {
  computeChartPrecision,
  formatActivityKind,
  formatLifecycleStatus,
  formatPercent,
  formatPrice,
  formatQuote,
  formatSide,
  formatUsd,
  formatVenueKind,
  toChartValue,
} from './format';

describe('formatUsd', () => {
  it('shows "—" instead of a fabricated value when null', () => {
    expect(formatUsd(null, 1)).toBe('—');
  });

  it('prefixes the value with $ and rounds to the given decimal places (list/detail figures: 1)', () => {
    expect(formatUsd('269.17', 1)).toBe('$269.2');
  });

  it('rounds to 2 decimal places for transaction figures', () => {
    expect(formatUsd('45.875', 2)).toBe('$45.88');
  });

  it('keeps enough decimal digits for a sub-$1 FDV that the fixed decimal count alone would round away to $0.0', () => {
    // A freshly launched curve's first trade: see be/src/market/tokenStats.test.ts for the same figure.
    expect(formatUsd('0.00000000000002437968643389', 1)).toBe('$0.00000000000002');
  });
});

describe('formatPercent', () => {
  it('shows "—" instead of a fabricated value when null', () => {
    expect(formatPercent(null)).toEqual({ text: '—', className: 'text-muted-foreground' });
  });

  it('rounds a positive change to 2 decimal places with a leading + and a green class', () => {
    expect(formatPercent('12.3456')).toEqual({ text: '+12.35%', className: 'text-emerald-600' });
  });

  it('rounds a negative change to 2 decimal places, keeping its own minus sign, with a red class', () => {
    expect(formatPercent('-3.456')).toEqual({ text: '-3.46%', className: 'text-red-600' });
  });

  it('shows exactly zero without a sign, in a neutral class', () => {
    expect(formatPercent('0')).toEqual({ text: '0.00%', className: 'text-muted-foreground' });
  });
});

describe('formatQuote', () => {
  it('shows the raw decimal string with its symbol when a value is available', () => {
    expect(formatQuote('12.5', 'ROBIN')).toBe('12.5 ROBIN');
  });

  it('shows "—" instead of a fabricated zero when the value is null', () => {
    expect(formatQuote(null, 'ROBIN')).toBe('—');
  });

  it('keeps the exact decimal string for a 6-decimal ERC-20 amount, without rounding', () => {
    expect(formatQuote('123.456789', 'USDC')).toBe('123.456789 USDC');
  });
});

describe('formatPrice', () => {
  it('shows "—" instead of a fabricated value when null', () => {
    expect(formatPrice(null, 'ETH')).toBe('—');
  });

  it('rounds to 2 decimal places once the price is at or above 1 unit', () => {
    expect(formatPrice('1459.0671', 'USDG')).toBe('1459.07 USDG');
  });

  it('keeps enough decimal digits that a sub-1 Pons-scale price is not rounded away to 0.00', () => {
    expect(formatPrice('0.000000152480063034', 'ETH')).toBe('0.00000015 ETH');
  });

  it('shows exactly 0 at the standard 2 decimal places, not an unbounded number of zeros', () => {
    expect(formatPrice('0', 'ETH')).toBe('0.00 ETH');
  });
});

describe('formatSide', () => {
  it('labels a buy as "Buy"', () => {
    expect(formatSide('buy')).toBe('Buy');
  });

  it('labels a sell as "Sell"', () => {
    expect(formatSide('sell')).toBe('Sell');
  });
});

describe('formatActivityKind', () => {
  it('labels a protocol buyback as done by Pons, not the user', () => {
    expect(formatActivityKind('protocol_buyback')).toBe('Buyback by Pons');
  });

  it('labels a protocol fee conversion as done by Pons, not the user', () => {
    expect(formatActivityKind('protocol_fee_conversion')).toBe('Fee conversion by Pons');
  });

  it('labels an unattributed protocol swap neutrally, without guessing it is a buyback', () => {
    expect(formatActivityKind('protocol_internal')).toBe('Internal Pons transaction');
  });

  it('returns null for an ordinary user trade so callers fall back to the buy/sell side label', () => {
    expect(formatActivityKind('user_trade')).toBeNull();
  });
});

describe('formatLifecycleStatus', () => {
  it('labels the swept phase', () => {
    expect(formatLifecycleStatus('swept')).toBe('Swept');
  });

  it('labels the rescued phase', () => {
    expect(formatLifecycleStatus('rescued')).toBe('Rescued');
  });
});

describe('formatVenueKind', () => {
  it('labels the bonding curve venue', () => {
    expect(formatVenueKind('curve')).toBe('Bonding curve');
  });

  it('labels the V4 pool venue', () => {
    expect(formatVenueKind('v4_pool')).toBe('Uniswap V4 Pool');
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
