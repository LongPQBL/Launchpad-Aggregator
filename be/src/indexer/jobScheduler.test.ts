import { describe, expect, it } from 'vitest';
import type { IndexBatch } from '../domain/types.js';
import type { NewScanJob, ScanJob } from './jobTypes.js';
import type { SourceDefinition } from './jobPlanner.js';
import { runJobScheduler, type SchedulerDeps } from './jobScheduler.js';

const empty: IndexBatch = { rawLogs: [], launches: [], venues: [], trades: [], transitions: [] };

function harness(sources: SourceDefinition[], frontiers: ReadonlyMap<string, bigint>, execute: SchedulerDeps['executeJob'],
  limits: Readonly<Record<string, number>> = { shared: 2, trades: 1 }) {
  const jobs: ScanJob[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  let now = Date.now();
  const deps: SchedulerDeps = {
    once: true,
    endpointLimits: limits,
    endpointFor: (id) => id.includes('trades') || id === 'pons-v2-curve' ? 'trades' : 'shared',
    getSafeHead: async () => 105n,
    listSources: async () => sources,
    getFrontiers: async () => frontiers,
    estimatePoolCount: async () => 0,
    enqueueJob: async (input: NewScanJob) => {
      const id = `${input.sourceId}:${input.lane}:${input.fromBlock}-${input.toBlock}`;
      if (!jobs.some((job) => job.id === id)) jobs.push({ ...input, id, generation: 0n,
        status: 'pending', leaseOwner: null, leaseUntil: null });
    },
    claimJob: async (owner, _time, _leaseMs, allowed) => {
      const job = jobs.find((item) => item.status === 'pending' && allowed.includes(item.sourceId));
      if (!job) return null;
      job.status = 'leased'; job.leaseOwner = owner;
      return { ...job };
    },
    executeJob: execute,
    commitJob: async (id) => { completed.push(id); const job = jobs.find((item) => item.id === id)!; job.status = 'complete'; },
    failJob: async (id) => { failed.push(id); const job = jobs.find((item) => item.id === id)!; job.status = 'failed'; },
    now: () => new Date(now),
    wait: async (ms) => { now += ms; },
    plannerOptions: { maxWindowBlocks: 2n, maxJobs: 1, targetWorkUnits: 1_000n },
    leaseMs: 60_000,
    pollMs: 1_000,
  };
  return { deps, jobs, completed, failed };
}

describe('bounded parallel job scheduler', () => {
  it('starts an independent factory job while another factory job is still slow', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const setup = harness([
      { id: 'pons-v1-legacy', startBlock: 100n }, { id: 'pons-v1-active', startBlock: 100n },
    ], new Map(), async (job) => { started.push(job.sourceId); if (job.sourceId === 'pons-v1-legacy') await slow; return empty; });
    const running = runJobScheduler(setup.deps, new AbortController().signal);
    for (let i = 0; i < 10 && started.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['pons-v1-legacy', 'pons-v1-active']);
    release();
    await running;
    expect(setup.completed).toHaveLength(2);
  });

  it('does not enqueue a trade window beyond its factory coverage', async () => {
    const executed: string[] = [];
    const setup = harness([
      { id: 'pons-v1-active', startBlock: 100n }, { id: 'pons-v1-active-trades', startBlock: 100n },
    ], new Map([['pons-v1-active', 99n]]), async (job) => { executed.push(job.sourceId); return empty; });
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(executed).toEqual(['pons-v1-active']);
    expect(setup.jobs.some((job) => job.sourceId === 'pons-v1-active-trades')).toBe(false);
  });

  it('starts verified V4 pools at Initialize with a two-worker shared endpoint cap', async () => {
    const sources = [0, 1, 2].map((index) => ({ id: `pons-v2-v4:0x${index.toString(16).padStart(64, '0')}`,
      startBlock: 103n, verifiedInitialize: true }));
    const started: Array<{ id: string; from: bigint }> = [];
    let active = 0;
    let peak = 0;
    const setup = harness(sources, new Map([['pons-v2-lifecycle', 105n]]), async (job) => {
      active++; peak = Math.max(peak, active);
      started.push({ id: job.sourceId, from: job.fromBlock });
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return empty;
    });
    setup.deps.once = false;
    setup.deps.maxPasses = 2;
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(started).toHaveLength(3);
    expect(started.every((item) => item.from === 103n)).toBe(true);
    expect(peak).toBe(2);
  });

  it('does not commit a job when cancellation arrives while it is executing', async () => {
    const controller = new AbortController();
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async () => {
      controller.abort();
      return empty;
    });
    await runJobScheduler(setup.deps, controller.signal);
    expect(setup.completed).toEqual([]);
    expect(setup.jobs[0].status).toBe('leased');
  });

  it('cools down only the rate-limited endpoint before claiming another job', async () => {
    let attempts = 0;
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async () => {
      attempts++;
      throw new Error('429 Too Many Requests');
    }, { shared: 1, trades: 1 });
    setup.deps.plannerOptions = { maxWindowBlocks: 2n, maxJobs: 2, targetWorkUnits: 1_000n };
    setup.deps.once = false;
    setup.deps.maxPasses = 2;
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(attempts).toBe(1);
    expect(setup.jobs.map((job) => job.status)).toEqual(['failed', 'pending']);
  });

  it('lets a dedicated trade endpoint progress while the shared endpoint is busy', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const setup = harness([
      { id: 'pons-v1-active', startBlock: 100n }, { id: 'pons-v1-active-trades', startBlock: 100n },
    ], new Map([['pons-v1-active', 102n]]), async (job) => {
      started.push(job.sourceId);
      if (job.sourceId === 'pons-v1-active') await slow;
      return empty;
    }, { shared: 1, trades: 1 });
    const running = runJobScheduler(setup.deps, new AbortController().signal);
    for (let i = 0; i < 10 && started.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['pons-v1-active', 'pons-v1-active-trades']);
    release();
    await running;
  });
});
