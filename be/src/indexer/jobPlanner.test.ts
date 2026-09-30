import { describe, expect, it } from 'vitest';
import { dependencyFrontier, isFactorySource, planCertifiedJobs, planProvisionalWindow } from './jobPlanner.js';

const small = { maxWindowBlocks: 2n, maxJobs: 20, targetWorkUnits: 1_000n };
const noPools = async () => 0;

describe('parallel scan job planner', () => {
  it('plans independent factory windows from any requested historical position', async () => {
    const source = { id: 'pons-v1-active', startBlock: 100n };
    expect(await planCertifiedJobs(source, 100n, 105n, new Map(), noPools, small)).toEqual([
      { fromBlock: 100n, toBlock: 101n }, { fromBlock: 102n, toBlock: 103n }, { fromBlock: 104n, toBlock: 105n },
    ]);
    expect(await planCertifiedJobs(source, 104n, 105n, new Map(), noPools, small)).toEqual([
      { fromBlock: 104n, toBlock: 105n },
    ]);
  });

  it('stops V1 trade windows at the certified factory frontier', async () => {
    const source = { id: 'pons-v1-active-trades', startBlock: 100n };
    const frontiers = new Map([['pons-v1-active', 104n]]);
    expect(dependencyFrontier(source.id, frontiers)).toEqual({ ready: true, maximumBlock: 104n });
    expect(await planCertifiedJobs(source, 100n, 110n, frontiers, noPools, small)).toEqual([
      { fromBlock: 100n, toBlock: 101n }, { fromBlock: 102n, toBlock: 103n }, { fromBlock: 104n, toBlock: 104n },
    ]);
    expect(await planCertifiedJobs(source, 100n, 110n, new Map(), noPools, small)).toEqual([]);
  });

  it('requires the V2 launch frontier for lifecycle and curve windows', async () => {
    const frontiers = new Map([['pons-v2', 103n]]);
    for (const id of ['pons-v2-lifecycle', 'pons-v2-curve']) {
      expect(await planCertifiedJobs({ id, startBlock: 100n }, 100n, 110n, frontiers, noPools, small)).toEqual([
        { fromBlock: 100n, toBlock: 101n }, { fromBlock: 102n, toBlock: 103n },
      ]);
      expect(await planCertifiedJobs({ id, startBlock: 100n }, 100n, 110n, new Map(), noPools, small)).toEqual([]);
    }
  });

  it('plans V4 only after a verified Initialize and lifecycle frontier', async () => {
    const source = { id: `pons-v2-v4:0x${'a'.repeat(64)}`, startBlock: 103n, verifiedInitialize: true };
    const frontiers = new Map([['pons-v2-lifecycle', 105n]]);
    expect(await planCertifiedJobs(source, 100n, 110n, frontiers, noPools, small)).toEqual([
      { fromBlock: 103n, toBlock: 104n }, { fromBlock: 105n, toBlock: 105n },
    ]);
    expect(await planCertifiedJobs({ ...source, verifiedInitialize: false }, 100n, 110n, frontiers, noPools, small)).toEqual([]);
    expect(await planCertifiedJobs(source, 100n, 110n, new Map(), noPools, small)).toEqual([]);
  });

  it('uses smaller windows when more pools make the same block span expensive', async () => {
    const source = { id: 'pons-v1-active-trades', startBlock: 100n };
    const frontiers = new Map([['pons-v1-active', 120n]]);
    const estimate = async (fromBlock: bigint) => fromBlock < 110n ? 1 : 10;
    const windows = await planCertifiedJobs(source, 100n, 113n, frontiers, estimate,
      { maxWindowBlocks: 5n, maxJobs: 20, targetWorkUnits: 20n });
    expect(windows).toEqual([
      { fromBlock: 100n, toBlock: 104n }, { fromBlock: 105n, toBlock: 109n },
      { fromBlock: 110n, toBlock: 111n }, { fromBlock: 112n, toBlock: 113n },
    ]);
  });

  it('recognizes only registered Pons factory sources', () => {
    expect(isFactorySource('pons-v1-legacy')).toBe(true);
    expect(isFactorySource('pons-v1-active')).toBe(true);
    expect(isFactorySource('pons-v2')).toBe(true);
    expect(isFactorySource('pons-v2-lifecycle')).toBe(false);
    expect(isFactorySource('pons-v1-active-trades')).toBe(false);
    expect(isFactorySource(`pons-v2-v4:0x${'a'.repeat(64)}`)).toBe(false);
  });

  it('plans a single near-head provisional window clipped to source startBlock', () => {
    const source = { id: 'pons-v1-active', startBlock: 100n };
    expect(planProvisionalWindow(source, 150n, 20n)).toEqual({ fromBlock: 131n, toBlock: 150n });
    expect(planProvisionalWindow(source, 110n, 20n)).toEqual({ fromBlock: 100n, toBlock: 110n });
  });

  it('returns null for a provisional window when safe head has not reached the source startBlock', () => {
    expect(planProvisionalWindow({ id: 'pons-v1-active', startBlock: 100n }, 99n, 20n)).toBeNull();
  });

  it('rejects an invalid provisional window size', () => {
    const source = { id: 'pons-v1-active', startBlock: 100n };
    expect(() => planProvisionalWindow(source, 150n, 0n)).toThrow('Invalid scan job planning bounds');
    expect(() => planProvisionalWindow(source, 150n, 2_001n)).toThrow('Invalid scan job planning bounds');
  });
});
