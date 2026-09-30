import type { IndexBatch, SourceCursor } from '../domain/types.js';
import type { ScanJob } from './jobTypes.js';
import { scanToHead, type LogSource, type ScanDeps } from './scan.js';

export interface PonsJobDeps {
  source: LogSource;
  getLogs: ScanDeps['getLogs'];
  decodeLogs: ScanDeps['decodeLogs'];
  sleep: ScanDeps['sleep'];
}

export async function runPonsJob(job: ScanJob, deps: PonsJobDeps): Promise<IndexBatch> {
  if (job.sourceId !== deps.source.id || job.fromBlock < deps.source.startBlock || job.fromBlock > job.toBlock) {
    throw new Error('Pons job does not match its source');
  }
  let cursor = job.fromBlock - 1n;
  const batches: IndexBatch[] = [];
  const width = job.toBlock - job.fromBlock + 1n;
  const report = await scanToHead(deps.source, job.toBlock, {
    initialChunk: width < 2_000n ? width : 2_000n,
    maxChunk: 2_000n, minChunk: 1n, maxRetries: 6,
    getCursor: async (): Promise<SourceCursor> => ({ sourceId: job.sourceId, chainId: deps.source.chainId,
      scannedToBlock: cursor, confirmedToBlock: cursor, status: 'backfilling' }),
    getLogs: deps.getLogs, decodeLogs: deps.decodeLogs,
    saveIndexBatch: async (_sourceId, fromBlock, toBlock, batch) => {
      if (fromBlock !== cursor + 1n || toBlock > job.toBlock) throw new Error('Non-contiguous Pons job batch');
      batches.push(batch);
      cursor = toBlock;
    },
    sleep: deps.sleep,
  });
  if (report.missingRanges.length || cursor !== job.toBlock) {
    throw new Error(report.missingRanges[0]?.reason ?? 'Pons job did not cover its whole block range');
  }
  return {
    rawLogs: batches.flatMap((batch) => batch.rawLogs),
    launches: batches.flatMap((batch) => batch.launches),
    venues: batches.flatMap((batch) => batch.venues),
    trades: batches.flatMap((batch) => batch.trades),
    transitions: batches.flatMap((batch) => batch.transitions),
  };
}
