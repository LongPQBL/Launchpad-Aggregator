import { describe, expect, it } from 'vitest';
import { describePriceImpact, formatImpact, impactLevel, priceImpactBps, probeAmount, slippageWarning } from './price-impact';

describe('priceImpactBps', () => {
  it('is 0 when the big trade gets the same rate as the probe', () => {
    expect(priceImpactBps({ amountIn: 1_000_000n, output: 2_000_000n, probeIn: 10_000n, probeOut: 20_000n })).toBe(0);
  });
  it('measures the rate lost on the larger trade', () => {
    // Probe rate 2.0 out per in; the real trade got 1.8 per in -> 10% worse.
    expect(priceImpactBps({ amountIn: 1_000_000n, output: 1_800_000n, probeIn: 10_000n, probeOut: 20_000n })).toBe(1000);
  });
  it('never reports a negative impact', () => {
    expect(priceImpactBps({ amountIn: 1_000_000n, output: 2_100_000n, probeIn: 10_000n, probeOut: 20_000n })).toBe(0);
  });
  it('is unknown, not zero, when a quote is missing or empty', () => {
    expect(priceImpactBps({ amountIn: 1_000_000n, output: null, probeIn: 10_000n, probeOut: 20_000n })).toBeNull();
    expect(priceImpactBps({ amountIn: 1_000_000n, output: 1n, probeIn: 10_000n, probeOut: 0n })).toBeNull();
    expect(priceImpactBps({ amountIn: 0n, output: 1n, probeIn: 1n, probeOut: 1n })).toBeNull();
  });
});

describe('probeAmount', () => {
  it('is 1% of the trade, and absent when that is too small to measure', () => {
    expect(probeAmount(1_000_000n)).toBe(10_000n);
    expect(probeAmount(50_000n)).toBeNull();
  });
});

describe('impact levels', () => {
  it('uses stricter thresholds for pools than for the steeper bonding curve', () => {
    expect(impactLevel(499, 'pool')).toBe('ok');
    expect(impactLevel(500, 'pool')).toBe('warn');
    expect(impactLevel(1500, 'pool')).toBe('severe');
    expect(impactLevel(1500, 'curve')).toBe('warn');
    expect(impactLevel(3000, 'curve')).toBe('severe');
    expect(impactLevel(null, 'pool')).toBe('ok');
  });
  it('formats small values without rounding them to zero', () => {
    expect(formatImpact(0.4)).toBe('<0.01%');
    expect(formatImpact(1234)).toBe('12.34%');
    expect(describePriceImpact(null, 'pool').text).toBeNull();
  });
});

describe('slippageWarning', () => {
  it('warns on values that invite sandwiching or likely failure, never on auto', () => {
    expect(slippageWarning('auto', 'pool')).toBeNull();
    expect(slippageWarning(100, 'pool')).toBeNull();
    expect(slippageWarning(501, 'pool')?.level).toBe('high');
    expect(slippageWarning(5, 'pool')?.level).toBe('low');
    expect(slippageWarning(1200, 'curve')).toBeNull();
    expect(slippageWarning(2600, 'curve')?.level).toBe('high');
  });
});
