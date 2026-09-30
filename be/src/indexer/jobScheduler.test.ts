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
      if (jobs.some((job) => job.id === id)) return;
      // Mirrors repository.ts's real certified-overlap check, including the same failure mode C1
      // regresses against — a mock that always accepted overlaps would hide the bug it's meant to catch.
      if (input.lane === 'certified') {
        const overlap = jobs.find((job) => job.sourceId === input.sourceId && job.lane === 'certified'
          && job.fromBlock <= input.toBlock && job.toBlock >= input.fromBlock);
        if (overlap) throw new Error(`Overlapping certified scan job: ${overlap.id}`);
      }
      jobs.push({ ...input, id, generation: 0n, status: 'pending', leaseOwner: null, leaseUntil: null });
    },
    claimJob: async (owner, _time, _leaseMs, allowed, lane) => {
      // Mirrors repository.ts's real `ORDER BY from_block, id` — a mock that picked in insertion
      // order instead would hide the C2 starvation bug it's meant to catch.
      const candidates = jobs.filter((item) => item.status === 'pending' && allowed.includes(item.sourceId)
        && (!lane || item.lane === lane));
      candidates.sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const job = candidates[0];
      if (!job) return null;
      job.status = 'leased'; job.leaseOwner = owner;
      return { ...job };
    },
    enqueueProvisionalWindow: async (sourceId, fromBlock, toBlock) => {
      const id = `${sourceId}:provisional:${fromBlock}-${toBlock}`;
      if (!jobs.some((job) => job.id === id)) jobs.push({ id, sourceId, lane: 'provisional', fromBlock, toBlock,
        generation: 0n, status: 'pending', leaseOwner: null, leaseUntil: null });
    },
    executeJob: execute,
    commitJob: async (id) => { completed.push(id); const job = jobs.find((item) => item.id === id)!; job.status = 'complete'; },
    failJob: async (id) => { failed.push(id); const job = jobs.find((item) => item.id === id)!; job.status = 'failed'; },
    now: () => new Date(now),
    wait: async (ms) => { now += ms; },
    getPlannedFrontiers: async () => {
      const map = new Map(frontiers);
      for (const job of jobs) {
        if (job.lane !== 'certified') continue;
        const current = map.get(job.sourceId);
        if (current === undefined || job.toBlock > current) map.set(job.sourceId, job.toBlock);
      }
      return map;
    },
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
    // Each worker slot now loops within a pass instead of claiming exactly once (see I1), so all 3
    // pass-1 windows complete inside pass 1 itself; pass 2's planning then correctly discovers the
    // next window per source (using the planned, not just certified, frontier — see C1) instead of
    // being unable to plan past a still-in-flight job. 3 sources x 2 passes = 6 total starts.
    expect(started).toHaveLength(6);
    expect(new Set(started.map((item) => item.id)).size).toBe(3);
    expect(started.every((item) => item.from === 103n || item.from === 105n)).toBe(true);
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
    // Planning is unconditional each pass (not gated by an endpoint cooldown), and now correctly plans
    // past whatever is already queued (certified or not — see C1) instead of blindly recomputing pass
    // 1's same two windows again; pass 2 discovers a genuine 3rd window while the endpoint cools down.
    expect(setup.jobs.map((job) => job.status)).toEqual(['failed', 'pending', 'pending']);
  });

  it('claims a reserved near-head provisional job even while certified backfill saturates its endpoint', async () => {
    const started: Array<{ sourceId: string; lane: string; toBlock: bigint }> = [];
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async (job) => {
      started.push({ sourceId: job.sourceId, lane: job.lane, toBlock: job.toBlock });
      return empty;
    }, { shared: 2, trades: 1 });
    setup.deps.provisionalWorkers = 1;
    setup.deps.plannerOptions = { maxWindowBlocks: 2n, maxJobs: 20, targetWorkUnits: 1_000n };
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(started.some((item) => item.lane === 'provisional' && item.toBlock === 105n)).toBe(true);
    expect(started.some((item) => item.lane === 'certified')).toBe(true);
  });

  it('does not plan a near-head provisional window for a trade source', async () => {
    const enqueued: string[] = [];
    const setup = harness([{ id: 'pons-v1-active-trades', startBlock: 100n }], new Map(), async () => empty);
    const originalEnqueue = setup.deps.enqueueProvisionalWindow;
    setup.deps.enqueueProvisionalWindow = async (sourceId, fromBlock, toBlock) => {
      enqueued.push(sourceId);
      return originalEnqueue(sourceId, fromBlock, toBlock);
    };
    setup.deps.provisionalWorkers = 1;
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(enqueued).toEqual([]);
  });

  it('does not crash the pass when a reorg-invalidated job also rejects failJob', async () => {
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async () => {
      throw new Error('some execution error');
    });
    setup.deps.failJob = async () => { throw new Error('Scan job lease is no longer valid'); };
    await expect(runJobScheduler(setup.deps, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('does not throw when the next pass would replan an overlapping certified window over one still pending (C1)', async () => {
    let calls = 0;
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async () => empty);
    setup.deps.claimJob = async () => null; // nothing is ever claimed: the job stays 'pending' across passes
    setup.deps.estimatePoolCount = async () => { calls++; return calls === 1 ? 1 : 10; };
    setup.deps.plannerOptions = { maxWindowBlocks: 100n, maxJobs: 1, targetWorkUnits: 50n };
    setup.deps.once = false;
    setup.deps.maxPasses = 2;
    await expect(runJobScheduler(setup.deps, new AbortController().signal)).resolves.toBeUndefined();
    const certifiedJobs = setup.jobs.filter((job) => job.sourceId === 'pons-v1-active' && job.lane === 'certified');
    expect(certifiedJobs).toHaveLength(1);
  });

  it('gives every source on a shared endpoint a fair turn across passes instead of starving the higher-block one (C2)', async () => {
    const started: string[] = [];
    const setup = harness([
      { id: 'pons-v1-active', startBlock: 100n }, { id: 'pons-v1-legacy', startBlock: 100n },
    ], new Map([['pons-v1-legacy', 500n]]), async (job) => { started.push(job.sourceId); return empty; }, { shared: 1, trades: 1 });
    setup.deps.getSafeHead = async () => 100_000n;
    // maxJobs high enough that pons-v1-active never runs out of pending work across every pass below —
    // otherwise it could "lose" a later pass by exhaustion rather than by the scheduler's own fairness.
    setup.deps.plannerOptions = { maxWindowBlocks: 1n, maxJobs: 20, targetWorkUnits: 1_000n };
    setup.deps.once = false;
    setup.deps.maxPasses = 6;
    await runJobScheduler(setup.deps, new AbortController().signal);
    expect(started).toContain('pons-v1-legacy');
  });

  it('lets another endpoint worker keep claiming new work while one worker is stuck on a slow job (I1)', async () => {
    // Single source with several pending windows, so this isolates I1 (the pass barrier) from C2
    // (cross-source fairness, covered separately above) — only the first-ever claimed job blocks.
    let firstJobStuck = true;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const fastCompletions: string[] = [];
    const setup = harness([{ id: 'pons-v1-active', startBlock: 100n }], new Map(), async (job) => {
      if (firstJobStuck) { firstJobStuck = false; await slow; return empty; }
      fastCompletions.push(job.id);
      return empty;
    }, { shared: 2, trades: 1 });
    setup.deps.plannerOptions = { maxWindowBlocks: 1n, maxJobs: 5, targetWorkUnits: 1_000n };
    const running = runJobScheduler(setup.deps, new AbortController().signal);
    for (let i = 0; i < 50 && fastCompletions.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fastCompletions.length).toBeGreaterThanOrEqual(3);
    release();
    await running;
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
