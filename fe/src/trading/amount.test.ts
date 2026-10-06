import { describe, expect, it } from 'vitest';
import { parseAmountSafe, applySlippage } from './amount';

describe('parseAmountSafe', () => {
  it('parses a plain decimal string', () => {
    expect(parseAmountSafe('1.5', 18)).toBe(1_500_000_000_000_000_000n);
  });

  it('returns 0n for an empty string', () => {
    expect(parseAmountSafe('', 18)).toBe(0n);
  });

  it('returns 0n instead of throwing for scientific notation', () => {
    expect(parseAmountSafe('1e5', 18)).toBe(0n);
  });

  it('returns 0n instead of throwing for other malformed input', () => {
    expect(parseAmountSafe('abc', 18)).toBe(0n);
    expect(parseAmountSafe('-1', 18)).toBe(0n);
  });
});

describe('applySlippage', () => {
  it('uses a wider auto default on the curve than on a graduated pool', () => {
    const curveResult = applySlippage(1_000_000n, 'auto', 'curve');
    const poolResult = applySlippage(1_000_000n, 'auto', 'pool');
    expect(curveResult).toBeLessThan(poolResult);
  });

  it('uses a custom slippage value when provided, regardless of venueKind', () => {
    // 500 bps = 5%
    expect(applySlippage(1_000_000n, 500, 'pool')).toBe(950_000n);
    expect(applySlippage(1_000_000n, 500, 'curve')).toBe(950_000n);
  });
});
