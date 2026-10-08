import { describe, expect, it } from 'vitest';
import { usdPriceFor, usdText } from './trade-usd';

describe('usdPriceFor', () => {
  const prices = { '0xabc0000000000000000000000000000000000001': '2.5', '0xabc0000000000000000000000000000000000002': null };
  it('looks the address up case-insensitively', () => {
    expect(usdPriceFor(prices, '0xABC0000000000000000000000000000000000001')).toBe('2.5');
  });
  it('is null for a null entry, a missing entry, or no prices at all', () => {
    expect(usdPriceFor(prices, '0xabc0000000000000000000000000000000000002')).toBeNull();
    expect(usdPriceFor(prices, '0xabc0000000000000000000000000000000000003')).toBeNull();
    expect(usdPriceFor(undefined, '0xabc0000000000000000000000000000000000001')).toBeNull();
  });
});

describe('usdText', () => {
  it('multiplies the token amount by the USD price', () => {
    expect(usdText(2_000_000_000_000_000_000n, 18, '1.5')).toBe('$3.00');
  });
  it('is null (hidden), never $0, when there is no price', () => {
    expect(usdText(1_000_000_000_000_000_000n, 18, null)).toBeNull();
    expect(usdText(1_000_000_000_000_000_000n, 18, undefined)).toBeNull();
  });
  it('renders a tiny non-zero value as a non-zero string, never $0', () => {
    expect(usdText(1_000_000_000_000_000_000n, 18, '0.0000001')).toBe('$0.00000010');
  });
  it('is null for a missing or zero amount', () => {
    expect(usdText(null, 18, '1.5')).toBeNull();
    expect(usdText(0n, 18, '1.5')).toBeNull();
  });
});
