import { describe, expect, it } from 'vitest';
import { getFactoryLogSources } from '../cli/indexer.js';
import { runFactoryCycle } from './factoryCycle.js';

describe('factory indexing cycle', () => {
  it('scans all factories fairly in bounded slices and leaves incomplete sources pending', async () => {
    const sources = getFactoryLogSources();
    const seen: Array<{ id: string; target: bigint }> = [];
    const recorded: string[] = [];
    const cursors = new Map(sources.map((source) => [source.id, source.startBlock - 1n]));
    const report = await runFactoryCycle(sources, 100_000_000n, 100n, {
      getCursor: async (id) => ({ sourceId: id, chainId: 4663, scannedToBlock: cursors.get(id)!, confirmedToBlock: cursors.get(id)!, status: 'backfilling' }),
      scan: async (source, target) => { seen.push({ id: source.id, target }); cursors.set(source.id, target); return { sourceId: source.id, committedRanges: [], missingRanges: [] }; },
      recordScanReport: async (report) => { recorded.push(report.sourceId); },
      setSourceStatus: async () => { throw new Error('should not be caught up'); },
    });
    expect(seen).toHaveLength(3);
    expect(recorded).toEqual(sources.map((source) => source.id));
    expect(seen[0].target).toBe(sources[0].startBlock + 99n);
    expect(report.every((item) => item.missingRanges.length === 0)).toBe(true);
  });

  it('scans all sources concurrently when parallel is requested, instead of one at a time', async () => {
    const sources = getFactoryLogSources();
    const started: string[] = [];
    const releases = new Map<string, (value: { sourceId: string; committedRanges: never[]; missingRanges: never[] }) => void>();
    const cursors = new Map(sources.map((source) => [source.id, source.startBlock - 1n]));
    const resultPromise = runFactoryCycle(sources, 100_000_000n, 100n, {
      getCursor: async (id) => ({ sourceId: id, chainId: 4663, scannedToBlock: cursors.get(id)!, confirmedToBlock: cursors.get(id)!, status: 'backfilling' }),
      scan: (source, target) => {
        started.push(source.id);
        return new Promise((resolve) => {
          releases.set(source.id, () => resolve({ sourceId: source.id, committedRanges: [], missingRanges: [] }));
        }).then((result) => { cursors.set(source.id, target); return result as never; });
      },
      recordScanReport: async () => {},
      setSourceStatus: async () => {},
    }, { parallel: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(3);
    for (const release of releases.values()) release(undefined as never);
    const report = await resultPromise;
    expect(report).toHaveLength(3);
  });
});
