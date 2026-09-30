export interface SourceProgress {
  sourceId: string;
  dependsOn: readonly string[];
  certifiedFrontier: bigint;
  startBlock: bigint;
}

export interface ThroughputSample {
  sourceId: string;
  windowStartBlock: bigint;
  windowEndBlock: bigint;
  elapsedSeconds: number;
  rpc429Count: number;
}

export interface SourceEstimate {
  sourceId: string;
  remainingBlocks: bigint;
  blocksPerSecondLow: number | null;
  blocksPerSecondHigh: number | null;
}

export type PipelineEstimate =
  | { reliable: true; etaSecondsLow: number; etaSecondsHigh: number; caveats: readonly string[] }
  | { reliable: false; reason: string; caveats: readonly string[] };

export interface BackfillEstimate {
  perSource: readonly SourceEstimate[];
  pipeline: PipelineEstimate;
}

export interface BackfillEstimateInput {
  safeHead: bigint;
  sources: readonly SourceProgress[];
  samples: readonly ThroughputSample[];
  unresolvedPoolDiscovery: boolean;
}

// A sample shorter than this cannot be trusted to extrapolate a real rate from — a burst of a few
// fast blocks (or one slow RPC round trip) would otherwise dominate the estimate.
const MIN_RELIABLE_SAMPLE_SECONDS = 30;
// More than this many 429s recorded against a source's recent samples means it is being actively
// rate-limited, not just occasionally retried — its throughput is not representative of steady state.
const REPEATED_429_THRESHOLD = 3;
const SAFE_HEAD_CAVEAT = 'Safe head keeps advancing during backfill, so remaining blocks and ETA are a snapshot, not a fixed target.';

export function estimateBackfill(input: BackfillEstimateInput): BackfillEstimate {
  const bySourceId = new Map(input.sources.map((source) => [source.sourceId, source]));
  for (const source of input.sources) {
    for (const dependency of source.dependsOn) {
      if (!bySourceId.has(dependency)) throw new Error(`Unknown dependency "${dependency}" for source "${source.sourceId}"`);
    }
  }

  const samplesBySourceId = new Map<string, ThroughputSample[]>();
  for (const sample of input.samples) {
    const list = samplesBySourceId.get(sample.sourceId) ?? [];
    list.push(sample);
    samplesBySourceId.set(sample.sourceId, list);
  }

  const perSource: SourceEstimate[] = [];
  let unreliableReason: string | null = null;

  for (const source of input.sources) {
    const remainingBlocks = source.certifiedFrontier < input.safeHead ? input.safeHead - source.certifiedFrontier : 0n;
    if (remainingBlocks === 0n) {
      perSource.push({ sourceId: source.sourceId, remainingBlocks, blocksPerSecondLow: null, blocksPerSecondHigh: null });
      continue;
    }
    const samples = samplesBySourceId.get(source.sourceId) ?? [];
    const totalElapsedSeconds = samples.reduce((total, sample) => total + sample.elapsedSeconds, 0);
    const total429 = samples.reduce((total, sample) => total + sample.rpc429Count, 0);
    if (samples.length === 0 || totalElapsedSeconds < MIN_RELIABLE_SAMPLE_SECONDS) {
      unreliableReason ??= `No reliable throughput sample yet for "${source.sourceId}" (need at least ${MIN_RELIABLE_SAMPLE_SECONDS}s of observed work).`;
      perSource.push({ sourceId: source.sourceId, remainingBlocks, blocksPerSecondLow: null, blocksPerSecondHigh: null });
      continue;
    }
    if (total429 >= REPEATED_429_THRESHOLD) {
      unreliableReason ??= `Repeated 429 rate limiting observed for "${source.sourceId}" (${total429} in the sample window).`;
      perSource.push({ sourceId: source.sourceId, remainingBlocks, blocksPerSecondLow: null, blocksPerSecondHigh: null });
      continue;
    }
    const rates = samples
      .filter((sample) => sample.elapsedSeconds > 0)
      .map((sample) => Number(sample.windowEndBlock - sample.windowStartBlock) / sample.elapsedSeconds);
    const blocksPerSecondLow = Math.min(...rates);
    const blocksPerSecondHigh = Math.max(...rates);
    perSource.push({ sourceId: source.sourceId, remainingBlocks, blocksPerSecondLow, blocksPerSecondHigh });
  }

  if (input.unresolvedPoolDiscovery) {
    unreliableReason ??= 'V4 pool discovery is not complete: undiscovered pools could add work not reflected in this estimate.';
  }

  const caveats = [SAFE_HEAD_CAVEAT];
  if (unreliableReason) return { perSource, pipeline: { reliable: false, reason: unreliableReason, caveats } };

  const estimateBySourceId = new Map(perSource.map((estimate) => [estimate.sourceId, estimate]));
  const finishLowMemo = new Map<string, number>();
  const finishHighMemo = new Map<string, number>();

  function ownDuration(estimate: SourceEstimate, rate: number | null): number {
    if (estimate.remainingBlocks === 0n || rate === null || rate <= 0) return 0;
    return Number(estimate.remainingBlocks) / rate;
  }

  // Fastest observed rate gives the best-case (low) duration; slowest gives the worst-case (high).
  function finish(sourceId: string, bound: 'low' | 'high'): number {
    const memo = bound === 'low' ? finishLowMemo : finishHighMemo;
    if (memo.has(sourceId)) return memo.get(sourceId)!;
    const source = bySourceId.get(sourceId)!;
    const estimate = estimateBySourceId.get(sourceId)!;
    const dependencyFinish = source.dependsOn.length
      ? Math.max(...source.dependsOn.map((id) => finish(id, bound)))
      : 0;
    const rate = bound === 'low' ? estimate.blocksPerSecondHigh : estimate.blocksPerSecondLow;
    const result = dependencyFinish + ownDuration(estimate, rate);
    memo.set(sourceId, result);
    return result;
  }

  const etaSecondsLow = input.sources.length ? Math.max(...input.sources.map((source) => finish(source.sourceId, 'low'))) : 0;
  const etaSecondsHigh = input.sources.length ? Math.max(...input.sources.map((source) => finish(source.sourceId, 'high'))) : 0;
  return { perSource, pipeline: { reliable: true, etaSecondsLow, etaSecondsHigh, caveats } };
}
