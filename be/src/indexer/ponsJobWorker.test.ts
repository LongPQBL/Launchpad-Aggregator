import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { IndexBatch } from '../domain/types.js';
import type { ScanJob } from './jobTypes.js';
import type { LogSource } from './scan.js';
import { runPonsJob } from './ponsJobWorker.js';

const source: LogSource = { id: 'pons-v1-active', chainId: 4663, startBlock: 100n,
  addresses: ['0x1111111111111111111111111111111111111111' as Address], events: [] };
const job: ScanJob = { id: 'job-1', sourceId: source.id, lane: 'certified', fromBlock: 100n, toBlock: 103n,
  generation: 0n, status: 'leased', leaseOwner: 'worker', leaseUntil: new Date(Date.now() + 60_000) };
const empty: IndexBatch = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };

describe('Pons block-window worker', () => {
  it('reads and decodes exactly the assigned range without committing partial data', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const result = await runPonsJob(job, { source, getLogs: async (_source, from, to) => {
      calls.push([from, to]); return [];
    }, decodeLogs: async () => empty, sleep: async () => {} });
    expect(calls).toEqual([[100n, 103n]]);
    expect(result).toEqual(empty);
  });

  it('retries smaller RPC ranges and merges decoded batches before one job commit', async () => {
    const calls: Array<[bigint, bigint]> = [];
    let decoded = 0;
    const result = await runPonsJob(job, { source, getLogs: async (_source, from, to) => {
      calls.push([from, to]);
      if (to - from + 1n > 2n) throw new Error('block range too large');
      return [];
    }, decodeLogs: async () => { decoded++; return empty; }, sleep: async () => {} });
    expect(calls).toEqual([[100n, 103n], [100n, 101n], [102n, 103n]]);
    expect(decoded).toBe(2);
    expect(result).toEqual(empty);
  });

  it('rejects a missing range instead of certifying an empty result', async () => {
    await expect(runPonsJob(job, { source, getLogs: async () => { throw new Error('archive required'); },
      decodeLogs: async () => empty, sleep: async () => {} })).rejects.toThrow(/archive required/);
  });
});
