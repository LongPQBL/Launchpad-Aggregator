import { describe, expect, it } from 'vitest';
import { applySlippage } from './amount';
import { formatBalanceAmount, formatTokenAmount, minReceivedText } from './trade-amount-format';

describe('formatBalanceAmount', () => {
  it('truncates instead of rounding up a balance near the entered amount', () => {
    expect(formatBalanceAmount(999_999_999_999_999_999n, 18)).toBe('0.999999');
    expect(formatBalanceAmount(1n, 18)).toBe('<0.000001');
    expect(formatBalanceAmount(1_234_567_890_000_000_000_000n, 18)).toBe('1,234.56789');
  });
});

describe('formatTokenAmount', () => {
  it('formats millions compactly with up to 4 fraction digits', () => {
    expect(formatTokenAmount(27_006_300_000_000_000_000_000_000n, 18)).toBe('27.0063M');
  });
  it('formats thousands and plain numbers', () => {
    expect(formatTokenAmount(1_500n * 10n ** 18n, 18)).toBe('1.5K');
    expect(formatTokenAmount(12_340_000_000_000_000_000n, 18)).toBe('12.34');
  });
  it('never shows a real non-zero amount as 0', () => {
    expect(formatTokenAmount(1n, 18)).toBe('<0.0001');
    expect(formatTokenAmount(0n, 18)).toBe('0');
  });
});

describe('minReceivedText', () => {
  it('is null (row hidden) when there is no quote', () => {
    expect(minReceivedText(null, 100, 'curve', 18, 'TOK')).toBeNull();
  });
  it('applies the same slippage math the submit path uses', () => {
    const out = 27_283_000_000_000_000_000_000_000n;
    const expected = formatTokenAmount(applySlippage(out, 100, 'curve'), 18);
    expect(minReceivedText(out, 100, 'curve', 18, 'PROMETHEUS')).toBe(`${expected} PROMETHEUS`);
    expect(minReceivedText(out, 100, 'curve', 18, 'PROMETHEUS')).toBe('27.0102M PROMETHEUS');
  });
  it('resolves Auto slippage per venue (curve 12%, pool 0.5%)', () => {
    const out = 1_000n * 10n ** 18n;
    expect(minReceivedText(out, 'auto', 'curve', 18, 'T')).toBe('880 T');
    expect(minReceivedText(out, 'auto', 'pool', 18, 'T')).toBe('995 T');
  });
  it('omits the symbol gracefully when unknown', () => {
    expect(minReceivedText(10n ** 18n, 0, 'pool', 18, null)).toBe('1');
  });
});
