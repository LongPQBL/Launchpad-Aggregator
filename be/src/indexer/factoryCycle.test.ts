import { describe, expect, it } from 'vitest';
import { getFactoryLogSources } from '../cli/indexer.js';
import { runFactoryCycle } from './factoryCycle.js';

describe('factory indexing cycle', () => {
  it('scans all factories fairly in bounded slices and leaves incomplete sources pending', async () => {
    const sources = getFactoryLogSources();
    const seen: Array<{ id: string; target: bigint }> = [];
    const cursors = new Map(sources.map((source) => [source.id, source.startBlock - 1n]));
    const report = await runFactoryCycle(sources, 100_000_000n, 100n, {
      getCursor: async (id) => ({ sourceId: id, chainId: 4663, scannedToBlock: cursors.get(id)!, confirmedToBlock: cursors.get(id)!, status: 'backfilling' }),
      scan: async (source, target) => { seen.push({ id: source.id, target }); cursors.set(source.id, target); return { sourceId: source.id, committedRanges: [], missingRanges: [] }; },
      setSourceStatus: async () => { throw new Error('should not be caught up'); },
    });
    expect(seen).toHaveLength(3);
    expect(seen[0].target).toBe(sources[0].startBlock + 99n);
    expect(report.every((item) => item.missingRanges.length === 0)).toBe(true);
  });
});
