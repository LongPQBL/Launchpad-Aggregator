import { describe, expect, it } from 'vitest';
import { launchKeysFromChanges } from './invalidate.js';

describe('launchKeysFromChanges', () => {
  it('returns one key per distinct launch across all changed kinds', () => {
    const keys = launchKeysFromChanges([
      { kind: 'trade.created', chainId: 4663, tokenAddress: '0xaa' },
      { kind: 'trade.created', chainId: 4663, tokenAddress: '0xaa' },
      { kind: 'launch.changed', chainId: 4663, tokenAddress: '0xaa' },
      { kind: 'launch.changed', chainId: 4663, tokenAddress: '0xbb' },
    ]);
    expect(keys).toEqual([
      { chainId: 4663, tokenAddress: '0xaa' },
      { chainId: 4663, tokenAddress: '0xbb' },
    ]);
  });

  it('keeps the same token on different chains as separate launches', () => {
    const keys = launchKeysFromChanges([
      { kind: 'trade.created', chainId: 4663, tokenAddress: '0xaa' },
      { kind: 'trade.created', chainId: 1, tokenAddress: '0xaa' },
    ]);
    expect(keys).toHaveLength(2);
  });

  it('ignores a change that names no token', () => {
    expect(launchKeysFromChanges([{ kind: 'trade.created', chainId: 4663 }])).toEqual([]);
  });
});
