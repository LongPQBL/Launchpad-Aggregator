import { describe, expect, it } from 'vitest';
import { compareLaunchCounts, compareTradeCounts } from './compareStaging.js';

describe('compareLaunchCounts', () => {
  it('reports tokens present in only one side and the matching count', () => {
    const real = [{ tokenAddress: '0xaaa' }, { tokenAddress: '0xbbb' }];
    const staging = [{ tokenAddress: '0xbbb' }, { tokenAddress: '0xccc' }];
    expect(compareLaunchCounts(real, staging)).toEqual({
      onlyInReal: ['0xaaa'], onlyInStaging: ['0xccc'], matching: 1,
    });
  });

  it('reports no diff when both sides match exactly', () => {
    const both = [{ tokenAddress: '0xaaa' }];
    expect(compareLaunchCounts(both, both)).toEqual({ onlyInReal: [], onlyInStaging: [], matching: 1 });
  });
});

describe('compareTradeCounts', () => {
  it('keys trades by (txHash, logIndex), not by row identity', () => {
    const real = [{ txHash: '0x1', logIndex: 0 }, { txHash: '0x1', logIndex: 1 }];
    const staging = [{ txHash: '0x1', logIndex: 0 }];
    expect(compareTradeCounts(real, staging)).toEqual({
      onlyInReal: ['0x1:1'], onlyInStaging: [], matching: 1,
    });
  });
});
