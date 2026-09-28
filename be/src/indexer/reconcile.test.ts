import { describe, expect, it } from 'vitest';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { getCoverage, reconcileLaunchCounts, scanFactoryLaunchCount } from './reconcile.js';

describe('coverage and independent reconciliation', () => {
  it('marks a missing block range incomplete with a visible reason', () => {
    const coverage = getCoverage(['pons-v2'], [{ sourceId: 'pons-v2', chainId: 4663, scannedToBlock: 200n,
      confirmedToBlock: 190n, status: 'degraded' }], [{ sourceId: 'pons-v2', fromBlock: 150n, toBlock: 160n,
      reason: 'archive required' }], 200n);
    expect(coverage.complete).toBe(false);
    expect(coverage.missingRanges).toHaveLength(1);
    expect(coverage.missingRanges[0].reason).toBe('archive required');
  });

  it('requires all requested sources to be caught up before marking complete', () => {
    const coverage = getCoverage(['a', 'b'], [{ sourceId: 'a', chainId: 4663, scannedToBlock: 200n,
      confirmedToBlock: 200n, status: 'caught_up' }], [], 200n);
    expect(coverage.complete).toBe(false);
    expect(coverage.pendingSourceIds).toEqual(['b']);
  });

  it('flags a launch count mismatch against an independent source', () => {
    const result = reconcileLaunchCounts(getPonsFactorySources()[2], 98, 100);
    expect(result.complete).toBe(false);
    expect(result.difference).toBe(2);
    expect(reconcileLaunchCounts(getPonsFactorySources()[2], 100, 100).complete).toBe(true);
  });

  it('rescans factory logs with overlapping chunks and deduplicates the boundary', async () => {
    const factory = { ...getPonsFactorySources()[2], startBlock: 10n };
    const calls: Array<[bigint, bigint]> = [];
    const count = await scanFactoryLaunchCount(factory, 14n, 3n, async (from, to) => {
      calls.push([from, to]);
      return [10n, 12n, 14n].filter((block) => block >= from && block <= to)
        .map((block) => ({ blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex: 0 }));
    });
    expect(count).toBe(3);
    expect(calls).toEqual([[10n, 12n], [12n, 14n]]);
  });
});
