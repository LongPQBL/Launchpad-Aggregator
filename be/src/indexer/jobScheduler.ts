import type { IndexBatch } from '../domain/types.js';
import type { NewScanJob, ScanJob } from './jobTypes.js';
import type { PlannerOptions, SourceDefinition } from './jobPlanner.js';
import { planCertifiedJobs } from './jobPlanner.js';
import { retryDelayMs, safeErrorMessage } from './scan.js';

export interface SchedulerDeps {
  once?: boolean;
  maxPasses?: number;
  endpointLimits: Readonly<Record<string, number>>;
  endpointFor(sourceId: string): string;
  getSafeHead(): Promise<bigint>;
  listSources(): Promise<readonly SourceDefinition[]>;
  getFrontiers(): Promise<ReadonlyMap<string, bigint>>;
  estimatePoolCount(sourceId: string, fromBlock: bigint, toBlock: bigint): Promise<number>;
  enqueueJob(input: NewScanJob): Promise<unknown>;
  claimJob(workerId: string, now: Date, leaseMs: number, allowedSourceIds: readonly string[]): Promise<ScanJob | null>;
  executeJob(job: ScanJob, signal: AbortSignal): Promise<IndexBatch>;
  commitJob(jobId: string, workerId: string, generation: bigint, batch: IndexBatch): Promise<void>;
  failJob(jobId: string, workerId: string, generation: bigint, reason: string): Promise<void>;
  now(): Date;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  plannerOptions?: Partial<PlannerOptions>;
  leaseMs: number;
  pollMs: number;
  onReport?(report: { jobId: string; sourceId: string; outcome: 'complete' | 'failed'; durationMs: number; error?: string }): void;
}

export async function runJobScheduler(deps: SchedulerDeps, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(deps.leaseMs) || deps.leaseMs < 1 || deps.leaseMs > 3_600_000
    || !Number.isSafeInteger(deps.pollMs) || deps.pollMs < 1) throw new Error('Invalid scheduler timing');
  const cooldowns = new Map<string, number>();
  const maxPasses = deps.once ? 1 : deps.maxPasses ?? Number.POSITIVE_INFINITY;
  let pass = 0;
  while (!signal.aborted && pass < maxPasses) {
    pass++;
    const [safeHead, sources, frontiers] = await Promise.all([
      deps.getSafeHead(), deps.listSources(), deps.getFrontiers(),
    ]);
    for (const source of sources) {
      if (signal.aborted) break;
      const fromBlock = (frontiers.get(source.id) ?? (source.startBlock - 1n)) + 1n;
      const windows = await planCertifiedJobs(source, fromBlock, safeHead, frontiers,
        (from, to) => deps.estimatePoolCount(source.id, from, to), deps.plannerOptions);
      for (const window of windows) {
        await deps.enqueueJob({ sourceId: source.id, lane: 'certified', ...window });
      }
    }
    const byEndpoint = new Map<string, string[]>();
    for (const source of sources) {
      const endpoint = deps.endpointFor(source.id);
      const list = byEndpoint.get(endpoint) ?? [];
      list.push(source.id);
      byEndpoint.set(endpoint, list);
    }
    await Promise.all([...byEndpoint].flatMap(([endpoint, sourceIds]) => {
      const limit = deps.endpointLimits[endpoint];
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid endpoint worker limit: ${endpoint}`);
      if ((cooldowns.get(endpoint) ?? 0) > deps.now().getTime()) return [];
      return Array.from({ length: limit }, async (_, slot) => {
        if (signal.aborted) return;
        const workerId = `${endpoint}:${slot}`;
        const job = await deps.claimJob(workerId, deps.now(), deps.leaseMs, sourceIds);
        if (!job || signal.aborted) return;
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
          await deps.failJob(job.id, workerId, job.generation, message);
          if (/429|rate limit|too many requests|503|502/i.test(message)) {
            cooldowns.set(endpoint, deps.now().getTime() + retryDelayMs(message, 0));
          }
          deps.onReport?.({ jobId: job.id, sourceId: job.sourceId, outcome: 'failed',
            durationMs: Math.max(0, deps.now().getTime() - started), error: message });
        }
      });
    }));
    if (!deps.once && pass < maxPasses && !signal.aborted) await deps.wait(deps.pollMs, signal);
  }
}
