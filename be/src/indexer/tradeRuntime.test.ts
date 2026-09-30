import { describe, expect, it } from 'vitest';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { getGroupedTradeLogs, getTradeSourceDefinitions, tradeFrontier } from './tradeRuntime.js';

describe('official trade source runtime', () => {
  it('uses one grouped source per protocol venue kind with a factory checkpoint frontier', () => {
    const definitions = getTradeSourceDefinitions();
    expect(definitions.map((item) => item.source.id)).toEqual(['pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve']);
    expect(definitions[0].source.startBlock).toBe(getPonsFactorySources()[0].startBlock);
    expect(definitions[1].source.startBlock).toBe(getPonsFactorySources()[1].startBlock);
    expect(definitions[2].source.startBlock).toBe(getPonsFactorySources()[2].startBlock);
    const cursors = new Map([['pons-v1-legacy', 200n], ['pons-v1-active', 190n], ['pons-v2', 300n]]);
    expect(tradeFrontier(definitions[0].source.id, cursors)).toBe(200n);
    expect(tradeFrontier(definitions[1].source.id, cursors)).toBe(190n);
    expect(tradeFrontier(definitions[2].source.id, cursors)).toBe(300n);
  });

  it('batches large venue sets and does not query the chain for an empty set', async () => {
    const definition = getTradeSourceDefinitions()[0];
    const addresses = Array.from({ length: 205 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}` as const);
    const calls: number[] = [];
    const source = { ...definition.source, addresses };
    await getGroupedTradeLogs(source, 100n, 200n, 100, async (group) => { calls.push(group.addresses.length); return []; });
    expect(calls).toEqual([100, 100, 5]);
    await getGroupedTradeLogs({ ...source, addresses: [] }, 100n, 200n, 100, async () => { throw new Error('not called'); });
  });

  it('rejects the whole range if one address group fails', async () => {
    const source = { ...getTradeSourceDefinitions()[0].source, addresses: Array.from({ length: 101 }, (_, index) =>
      `0x${index.toString(16).padStart(40, '0')}` as const) };
    await expect(getGroupedTradeLogs(source, 100n, 200n, 100, async (group) => {
      if (group.addresses.length === 1) throw new Error('RPC group failed');
      return [];
    })).rejects.toThrow(/RPC group failed/);
  });

  it('fires more than 4 address groups concurrently instead of throttling to the old cap', async () => {
    // Measured 2026-09-30 against Validation Cloud: 14 concurrent 5,000-address getLogs calls
    // (pons-v1-active-trades' real group count) succeeded repeatedly with no errors in ~7-9s total,
    // vs the old cap of 4 concurrent groups serializing them into ~4 sequential rounds.
    const source = { ...getTradeSourceDefinitions()[0].source, addresses: Array.from({ length: 14 }, (_, index) =>
      `0x${index.toString(16).padStart(40, '0')}` as const) };
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const resultPromise = getGroupedTradeLogs(source, 100n, 200n, 1, (group) => {
      started.push(group.addresses.length);
      return new Promise((resolve) => { releases.push(() => resolve([])); });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(14);
    for (const release of releases) release();
    await resultPromise;
  });
});
