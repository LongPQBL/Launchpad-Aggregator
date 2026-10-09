import { describe, expect, it } from 'vitest';
import { formatVolumeToTvl, volumeToTvl } from './pool-format';

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
