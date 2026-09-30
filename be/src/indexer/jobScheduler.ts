import type { IndexBatch } from '../domain/types.js';
import type { NewScanJob, ScanJob } from './jobTypes.js';
import type { PlannerOptions, SourceDefinition } from './jobPlanner.js';
import { isFactorySource, planCertifiedJobs, planProvisionalWindow } from './jobPlanner.js';
import { retryDelayMs, safeErrorMessage } from './scan.js';

export interface SchedulerDeps {
  once?: boolean;
  maxPasses?: number;
  endpointLimits: Readonly<Record<string, number>>;
  endpointFor(sourceId: string): string;
  getSafeHead(): Promise<bigint>;
  listSources(): Promise<readonly SourceDefinition[]>;
  getFrontiers(): Promise<ReadonlyMap<string, bigint>>;
  // The frontier to plan NEW certified windows from — distinct from getFrontiers (which is the true
  // certified/complete frontier, used for downstream dependency gating). This one must also account for
  // certified jobs that are already queued (pending/leased) but not yet complete: planning from the bare
  // certified frontier every pass recomputes a window whose end can differ from an already-queued one
  // covering the same start (pool-count-driven width, or the safe-head truncation point moving), and the
  // certified-overlap check then rejects it — permanently, every pass, since the same recompute repeats.
  getPlannedFrontiers(): Promise<ReadonlyMap<string, bigint>>;
  estimatePoolCount(sourceId: string, fromBlock: bigint, toBlock: bigint): Promise<number>;
  enqueueJob(input: NewScanJob): Promise<unknown>;
  claimJob(workerId: string, now: Date, leaseMs: number, allowedSourceIds: readonly string[],
    lane?: 'certified' | 'provisional'): Promise<ScanJob | null>;
  executeJob(job: ScanJob, signal: AbortSignal): Promise<IndexBatch>;
  commitJob(jobId: string, workerId: string, generation: bigint, batch: IndexBatch): Promise<void>;
  failJob(jobId: string, workerId: string, generation: bigint, reason: string): Promise<void>;
  now(): Date;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  plannerOptions?: Partial<PlannerOptions>;
  leaseMs: number;
  pollMs: number;
  onReport?(report: { jobId: string; sourceId: string; outcome: 'complete' | 'failed'; durationMs: number; error?: string }): void;
  // Near-head provisional lane (docs/superpowers/specs/2026-09-30-parallel-indexer-design.md §4.1):
  // reserves `provisionalWorkers` worker slots out of `provisionalEndpoint`'s existing endpointLimits
  // entry so new launches surface at safe head without waiting behind historical backfill. 0 (default)
  // keeps prior sequential-equivalent behavior; only factory sources ever get a provisional window.
  enqueueProvisionalWindow(sourceId: string, fromBlock: bigint, toBlock: bigint): Promise<unknown>;
  provisionalWorkers?: number;
  provisionalWindowBlocks?: bigint;
  provisionalEndpoint?: string;
}

export async function runJobScheduler(deps: SchedulerDeps, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(deps.leaseMs) || deps.leaseMs < 1 || deps.leaseMs > 3_600_000
    || !Number.isSafeInteger(deps.pollMs) || deps.pollMs < 1) throw new Error('Invalid scheduler timing');
  const cooldowns = new Map<string, number>();
  // Rotating start index per endpoint, shared across every worker slot on that endpoint and carried
  // across passes for the life of this call — so claim attempts cycle through sources instead of a
  // global lowest-block-first order always favoring whichever source happens to be least caught up.
  const roundRobin = new Map<string, number>();
  // AIMD (TCP-congestion-control-style) concurrency per endpoint: deps.endpointLimits is the CEILING
  // (the highest value already known safe from real benchmarking), not a fixed operating point. A 429
  // multiplicatively halves the current value (floor 1); a pass that used the endpoint with no 429
  // additively climbs it back by one step, never past the ceiling. This finds/re-finds a safe rate
  // instead of always running at a stale hand-picked constant, and backs off fast but recovers gradually
  // so a recovery doesn't immediately re-trigger the same rate limit.
  const concurrencyLimits = new Map<string, number>();
  function endpointCeiling(endpoint: string): number {
    const ceiling = deps.endpointLimits[endpoint];
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new Error(`Invalid endpoint worker limit: ${endpoint}`);
    return ceiling;
  }
  function currentConcurrency(endpoint: string): number {
    return Math.min(concurrencyLimits.get(endpoint) ?? endpointCeiling(endpoint), endpointCeiling(endpoint));
  }
  const maxPasses = deps.once ? 1 : deps.maxPasses ?? Number.POSITIVE_INFINITY;
  let pass = 0;
  while (!signal.aborted && pass < maxPasses) {
    pass++;
    const [safeHead, sources, frontiers, plannedFrontiers] = await Promise.all([
      deps.getSafeHead(), deps.listSources(), deps.getFrontiers(), deps.getPlannedFrontiers(),
    ]);
    for (const source of sources) {
      if (signal.aborted) break;
      const fromBlock = (plannedFrontiers.get(source.id) ?? (source.startBlock - 1n)) + 1n;
      const windows = await planCertifiedJobs(source, fromBlock, safeHead, frontiers,
        (from, to) => deps.estimatePoolCount(source.id, from, to), deps.plannerOptions);
      for (const window of windows) {
        await deps.enqueueJob({ sourceId: source.id, lane: 'certified', ...window });
      }
    }
    const factorySourceIds = sources.filter((source) => isFactorySource(source.id)).map((source) => source.id);
    const provisionalWorkers = deps.provisionalWorkers ?? 0;
    const provisionalEndpoint = deps.provisionalEndpoint ?? 'shared';
    if (provisionalWorkers > 0) {
      for (const source of sources) {
        if (signal.aborted || !isFactorySource(source.id)) continue;
        const window = planProvisionalWindow(source, safeHead, deps.provisionalWindowBlocks ?? 2_000n);
        if (window) await deps.enqueueProvisionalWindow(source.id, window.fromBlock, window.toBlock);
      }
    }
    const byEndpoint = new Map<string, string[]>();
    for (const source of sources) {
      const endpoint = deps.endpointFor(source.id);
      const list = byEndpoint.get(endpoint) ?? [];
      list.push(source.id);
      byEndpoint.set(endpoint, list);
    }
    // Tries each source in rotating order (not sourceIds' own, usually block-ascending, order) so a
    // claim attempt across an endpoint's sources doesn't always land on whichever source is least
    // caught up. Advancing the shared round-robin index on every attempt (not only successful ones)
    // keeps concurrent slots on the same endpoint from all starting at the same place.
    async function claimFairly(endpoint: string, workerId: string, sourceIds: readonly string[],
      lane?: 'certified' | 'provisional'): Promise<ScanJob | null> {
      if (sourceIds.length === 0) return null;
      const start = (roundRobin.get(endpoint) ?? 0) % sourceIds.length;
      roundRobin.set(endpoint, start + 1);
      const order = [...sourceIds.slice(start), ...sourceIds.slice(0, start)];
      for (const sourceId of order) {
        const job = await deps.claimJob(workerId, deps.now(), deps.leaseMs, [sourceId], lane);
        if (job) return job;
      }
      return null;
    }
    const rateLimitedThisPass = new Set<string>();
    const usedThisPass = new Set<string>();
    // Each worker slot loops claim -> execute -> commit/fail -> claim again until no more claimable
    // work remains (or it cools down / the pass ends), instead of doing exactly one claim and then
    // sitting idle until every other slot's Promise.all settles. Without this, one slow job holds the
    // whole endpoint's other slots back from claiming further ready work for the rest of the pass.
    const runWorkerLoop = async (endpoint: string, workerId: string, sourceIds: readonly string[],
      lane?: 'certified' | 'provisional') => {
      while (!signal.aborted) {
        if ((cooldowns.get(endpoint) ?? 0) > deps.now().getTime()) return;
        const job = await claimFairly(endpoint, workerId, sourceIds, lane);
        if (!job || signal.aborted) return;
        usedThisPass.add(endpoint);
        const started = deps.now().getTime();
        try {
          const batch = await deps.executeJob(job, signal);
          if (signal.aborted) return;
          await deps.commitJob(job.id, workerId, job.generation, batch);
          deps.onReport?.({ jobId: job.id, sourceId: job.sourceId, outcome: 'complete',
            durationMs: Math.max(0, deps.now().getTime() - started) });
        } catch (error) {
          if (signal.aborted) return;
          const message = safeErrorMessage(error);
          // A reorg (repository.invalidateJobsFrom) can delete this job out from under an in-flight
          // worker; failJob then rejects the same way a stale/superseded lease does. That is the fence
          // working as intended, not a scheduler failure — report and move on, never let it escape and
          // take down the whole pass's Promise.all.
          try {
            await deps.failJob(job.id, workerId, job.generation, message);
          } catch (failError) {
            deps.onReport?.({ jobId: job.id, sourceId: job.sourceId, outcome: 'failed',
              durationMs: Math.max(0, deps.now().getTime() - started), error: safeErrorMessage(failError) });
            return;
          }
          if (/429|rate limit|too many requests|503|502/i.test(message)) {
            cooldowns.set(endpoint, deps.now().getTime() + retryDelayMs(message, 0));
            rateLimitedThisPass.add(endpoint);
            concurrencyLimits.set(endpoint, Math.max(1, Math.floor(currentConcurrency(endpoint) / 2)));
          }
          deps.onReport?.({ jobId: job.id, sourceId: job.sourceId, outcome: 'failed',
            durationMs: Math.max(0, deps.now().getTime() - started), error: message });
        }
      }
    };
    await Promise.all([
      ...[...byEndpoint].flatMap(([endpoint, sourceIds]) => {
        const reserved = endpoint === provisionalEndpoint ? provisionalWorkers : 0;
        const limit = Math.max(0, currentConcurrency(endpoint) - reserved);
        if ((cooldowns.get(endpoint) ?? 0) > deps.now().getTime()) return [];
        return Array.from({ length: limit }, (_, slot) => runWorkerLoop(endpoint, `${endpoint}:${slot}`, sourceIds, 'certified'));
      }),
      ...(provisionalWorkers > 0 && (cooldowns.get(provisionalEndpoint) ?? 0) <= deps.now().getTime()
        ? Array.from({ length: provisionalWorkers }, (_, slot) =>
          runWorkerLoop(provisionalEndpoint, `${provisionalEndpoint}:provisional:${slot}`, factorySourceIds, 'provisional'))
        : []),
    ]);
    for (const endpoint of usedThisPass) {
      if (rateLimitedThisPass.has(endpoint)) continue;
      concurrencyLimits.set(endpoint, Math.min(endpointCeiling(endpoint), currentConcurrency(endpoint) + 1));
    }
    if (!deps.once && pass < maxPasses && !signal.aborted) await deps.wait(deps.pollMs, signal);
  }
}
