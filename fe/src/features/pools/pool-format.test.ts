import { describe, expect, it } from 'vitest';
import { formatPoolFee, formatVolumeToTvl, volumeToTvl } from './pool-format';

describe('volumeToTvl', () => {
  it('divides 24h volume by liquidity', () => {
    expect(volumeToTvl({ volume24hUsd: '300000', tvlUsd: '100000' })).toBe(3);
  });

  it('is null, not zero, when either side is unknown or there is no liquidity', () => {
    expect(volumeToTvl({ volume24hUsd: null, tvlUsd: '100' })).toBeNull();
    expect(volumeToTvl({ volume24hUsd: '100', tvlUsd: null })).toBeNull();
    expect(volumeToTvl({ volume24hUsd: '100', tvlUsd: '0' })).toBeNull();
  });

  it('keeps a real zero volume as a real zero ratio', () => {
    expect(volumeToTvl({ volume24hUsd: '0', tvlUsd: '500' })).toBe(0);
  });
});

describe('formatVolumeToTvl', () => {
  it('shows two decimals, an em dash for unknown, and abbreviates very large ratios', () => {
    expect(formatVolumeToTvl(0.4567)).toBe('0.46');
    expect(formatVolumeToTvl(0)).toBe('0.00');
    expect(formatVolumeToTvl(null)).toBe('—');
    expect(formatVolumeToTvl(12_345)).toBe('12.3K');
  });
});

describe('formatPoolFee', () => {
  it('writes the fee as a percentage of fee / 10,000, so a large number is a real fee', () => {
    expect(formatPoolFee(3000)).toBe('0.3%');
    expect(formatPoolFee(500)).toBe('0.05%');
    expect(formatPoolFee(838974)).toBe('83.8974%'); // an on-chain static LP fee of 83.9%
  });
  it('does not read a dynamic-fee flag as a rate', () => {
    expect(formatPoolFee(0x800000)).toBe('Dynamic fee');
    expect(formatPoolFee(0x800000 + 3000, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044')).toBe('Dynamic fee');
  });
  it('does not call a pool with a hook free: the hook can take its own fee', () => {
    const hook = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
    expect(formatPoolFee(0, hook)).toBe('Hook fee');
    expect(formatPoolFee(3000, hook)).toBe('0.3% + hook');
    expect(formatPoolFee(0, '0x0000000000000000000000000000000000000000')).toBe('0%');
    expect(formatPoolFee(0, null)).toBe('0%');
  });
});
