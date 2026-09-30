import type { CoverageStatus, SourceCursor } from '../domain/types.js';
import type { LogSource, ScanReport } from './scan.js';

export interface FactoryCycleDeps {
  getCursor(id: string): Promise<SourceCursor>;
  scan(source: LogSource, target: bigint): Promise<ScanReport>;
  recordScanReport(report: ScanReport): Promise<void>;
  setSourceStatus(id: string, status: CoverageStatus, safeHead: bigint): Promise<void>;
}

export interface FactoryCycleOptions {
  // Only safe for sources with no per-event RPC lookups of their own (plain log scans) — measured
  // against the real RPC, running several trade-decoding sources (each already concurrent
  // internally) this way floods the provider with 429s almost immediately. See README.md.
  parallel?: boolean;
}

async function runOne(source: LogSource, safeHead: bigint, maxBlocksPerSource: bigint, deps: FactoryCycleDeps): Promise<ScanReport> {
  const cursor = await deps.getCursor(source.id);
  const target = cursor.scannedToBlock + maxBlocksPerSource < safeHead ? cursor.scannedToBlock + maxBlocksPerSource : safeHead;
  const report = await deps.scan(source, target);
  await deps.recordScanReport(report);
  const updated = await deps.getCursor(source.id);
  if (report.missingRanges.length) await deps.setSourceStatus(source.id, 'degraded', safeHead);
  else if (updated.confirmedToBlock >= safeHead || source.startBlock > safeHead) {
    await deps.setSourceStatus(source.id, 'caught_up', safeHead);
  }
  return report;
}

export async function runFactoryCycle(sources: readonly LogSource[], safeHead: bigint, maxBlocksPerSource: bigint,
  deps: FactoryCycleDeps, options?: FactoryCycleOptions): Promise<ScanReport[]> {
  if (safeHead < 0n || maxBlocksPerSource < 1n) throw new Error('Invalid factory cycle bounds');
  if (options?.parallel) return Promise.all(sources.map((source) => runOne(source, safeHead, maxBlocksPerSource, deps)));
  const reports: ScanReport[] = [];
  for (const source of sources) {
    reports.push(await runOne(source, safeHead, maxBlocksPerSource, deps));
  }
  return reports;
}
