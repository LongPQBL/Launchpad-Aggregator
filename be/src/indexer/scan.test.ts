import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { IndexBatch, SourceCursor, Venue } from '../domain/types.js';
import { groupVenueQueries } from './groupQueries.js';
import { scanToHead, type LogSource, type ScanDeps } from './scan.js';
import { getFactoryLogSources, runIndexerOnce } from '../cli/indexer.js';

const address = '0x1111111111111111111111111111111111111111' as Address;
const source: LogSource = { id: 'pons-v1-active', chainId: 4663, startBlock: 10n, addresses: [address], events: [] };
const emptyBatch: IndexBatch = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };

function depsFor(getLogs: ScanDeps['getLogs']) {
  let cursor = 9n;
  const committed: Array<[bigint, bigint]> = [];
  const deps: ScanDeps = {
    initialChunk: 8n,
    maxChunk: 8n,
    minChunk: 1n,
    maxRetries: 2,
    getCursor: async (): Promise<SourceCursor> => ({ sourceId: source.id, chainId: 4663, scannedToBlock: cursor, confirmedToBlock: cursor, status: 'backfilling' }),
    getLogs,
    decodeLogs: async () => emptyBatch,
    saveIndexBatch: async (_id, from, to) => { committed.push([from, to]); cursor = to; },
    sleep: async () => {},
  };
  return { deps, committed, getCursor: () => cursor };
}

describe('bounded HTTP scanner', () => {
  it('shrinks timed-out ranges without leaving a gap', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const setup = depsFor(async (_source, from, to) => {
      calls.push([from, to]);
      if (to - from + 1n > 3n) throw new Error('log query timed out');
      return [];
    });
    const report = await scanToHead(source, 18n, setup.deps);
    expect(calls[0]).toEqual([10n, 17n]);
    expect(setup.committed[0][0]).toBe(10n);
    expect(setup.committed.at(-1)?.[1]).toBe(18n);
    for (let i = 1; i < setup.committed.length; i++) {
      expect(setup.committed[i][0]).toBe(setup.committed[i - 1][1] + 1n);
    }
    expect(report.missingRanges).toEqual([]);
    expect(setup.getCursor()).toBe(18n);
  });

  it('reports a database failure without moving the checkpoint, then restarts at that block', async () => {
    const setup = depsFor(async () => []);
    setup.deps.saveIndexBatch = async () => { throw new Error('database unavailable'); };
    const report = await scanToHead(source, 12n, setup.deps);
    expect(report.missingRanges).toEqual([{ fromBlock: 10n, toBlock: 12n, reason: 'database unavailable' }]);
    expect(setup.getCursor()).toBe(9n);
    const resumed = depsFor(async () => []);
    await scanToHead(source, 12n, resumed.deps);
    expect(resumed.committed).toEqual([[10n, 12n]]);
  });

  it('reports an invalid lifecycle receipt as a gap without advancing the cursor', async () => {
    const setup = depsFor(async () => []);
    setup.deps.decodeLogs = async () => { throw new Error('No matching Pons V4 Initialize'); };
    const report = await scanToHead(source, 12n, setup.deps);
    expect(report.missingRanges).toEqual([{ fromBlock: 10n, toBlock: 12n, reason: 'No matching Pons V4 Initialize' }]);
    expect(setup.getCursor()).toBe(9n);
  });

  it('retries a transient rate limit hit while decoding (e.g. a per-token metadata eth_call), not just while fetching logs', async () => {
    const setup = depsFor(async () => []);
    let decodeAttempts = 0;
    setup.deps.decodeLogs = async () => {
      decodeAttempts++;
      if (decodeAttempts < 3) throw new Error('429 Too Many Requests');
      return emptyBatch;
    };
    let sleeps = 0;
    setup.deps.sleep = async () => { sleeps++; };
    const report = await scanToHead(source, 12n, setup.deps);
    expect(decodeAttempts).toBe(3);
    expect(sleeps).toBe(2);
    expect(report.missingRanges).toEqual([]);
    expect(setup.getCursor()).toBe(12n);
  });

  it('still reports a genuine decode error immediately, without retrying it as if it were transient', async () => {
    const setup = depsFor(async () => []);
    let decodeAttempts = 0;
    setup.deps.decodeLogs = async () => { decodeAttempts++; throw new Error('Unknown official V3 pool'); };
    const report = await scanToHead(source, 12n, setup.deps);
    expect(decodeAttempts).toBe(1);
    expect(report.missingRanges).toEqual([{ fromBlock: 10n, toBlock: 12n, reason: 'Unknown official V3 pool' }]);
    expect(setup.getCursor()).toBe(9n);
  });

  it('reports unavailable historical logs without advancing the checkpoint', async () => {
    const setup = depsFor(async () => { throw new Error('historical state is not available'); });
    const report = await scanToHead(source, 18n, setup.deps);
    expect(report.missingRanges).toEqual([{ fromBlock: 10n, toBlock: 17n, reason: 'historical state is not available' }]);
    expect(setup.getCursor()).toBe(9n);
  });

  it('retries a transient rate limit a bounded number of times', async () => {
    let attempts = 0;
    let sleeps = 0;
    const setup = depsFor(async () => {
      attempts++;
      if (attempts < 3) throw new Error('429 Too Many Requests');
      return [];
    });
    setup.deps.sleep = async () => { sleeps++; };
    await scanToHead(source, 10n, setup.deps);
    expect(attempts).toBe(3);
    expect(sleeps).toBe(2);
    expect(setup.getCursor()).toBe(10n);
  });

  it('backs off up to 8s (not the old 2s cap) so a real rate-limit window has a chance to clear', async () => {
    const delays: number[] = [];
    const setup = depsFor(async () => { throw new Error('429 Too Many Requests'); });
    setup.deps.maxRetries = 5;
    setup.deps.sleep = async (ms) => { delays.push(ms); };
    await scanToHead(source, 10n, setup.deps);
    expect(delays).toEqual([250, 500, 1000, 2000, 4000]);
  });

  it('eventually gives up a persistent rate limit as a gap, without advancing the checkpoint', async () => {
    let attempts = 0;
    const setup = depsFor(async () => { attempts++; throw new Error('429 Too Many Requests'); });
    setup.deps.maxRetries = 5;
    setup.deps.sleep = async () => {};
    const report = await scanToHead(source, 10n, setup.deps);
    expect(attempts).toBe(6);
    expect(report.missingRanges).toEqual([{ fromBlock: 10n, toBlock: 10n, reason: '429 Too Many Requests' }]);
    expect(setup.getCursor()).toBe(9n);
  });
});

describe('venue query batching', () => {
  it('groups 2,000 pools into 20 address batches of at most 100', () => {
    const venues = Array.from({ length: 2_000 }, (_, index) => ({
      kind: 'v3_pool',
      ref: `0x${index.toString(16).padStart(40, '0')}`,
      chainId: 4663,
    })) as Venue[];
    const queries = groupVenueQueries(venues, 100);
    expect(queries).toHaveLength(20);
    expect(queries.every((query) => query.kind === 'v3_pool' && query.addresses.length <= 100)).toBe(true);
    expect(queries.flatMap((query) => query.addresses)).toHaveLength(2_000);
  });
});

describe('indexer wiring', () => {
  it('uses all three registry factories with their versioned launch events', () => {
    const factories = getFactoryLogSources();
    expect(factories.map((item) => item.id)).toEqual(['pons-v1-legacy', 'pons-v1-active', 'pons-v2']);
    expect(factories.map((item) => item.startBlock)).toEqual([8600612n, 8991118n, 26841846n]);
    expect(factories.every((item) => item.chainId === 4663 && item.addresses.length === 1 && item.events.length === 1)).toBe(true);
  });

  it('refuses to advance any checkpoint when a source decoder is missing', async () => {
    const setup = depsFor(async () => []);
    const second: LogSource = { ...source, id: 'pons-v2' };
    await expect(runIndexerOnce([source, second], async () => 10n, (item) => item.id === source.id ? setup.deps : undefined)).rejects.toThrow(/decoder.*pons-v2/i);
    expect(setup.committed).toEqual([]);
  });
});
