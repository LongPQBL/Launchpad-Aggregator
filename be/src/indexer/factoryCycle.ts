import type { CoverageStatus, SourceCursor } from '../domain/types.js';
import type { LogSource, ScanReport } from './scan.js';

export interface FactoryCycleDeps {
  getCursor(id: string): Promise<SourceCursor>;
  scan(source: LogSource, target: bigint): Promise<ScanReport>;
  setSourceStatus(id: string, status: CoverageStatus, safeHead: bigint): Promise<void>;
}

export async function runFactoryCycle(sources: readonly LogSource[], safeHead: bigint, maxBlocksPerSource: bigint,
  deps: FactoryCycleDeps): Promise<ScanReport[]> {
  if (safeHead < 0n || maxBlocksPerSource < 1n) throw new Error('Invalid factory cycle bounds');
  const reports: ScanReport[] = [];
  for (const source of sources) {
    const cursor = await deps.getCursor(source.id);
    const target = cursor.scannedToBlock + maxBlocksPerSource < safeHead ? cursor.scannedToBlock + maxBlocksPerSource : safeHead;
    const report = await deps.scan(source, target);
    reports.push(report);
    const updated = await deps.getCursor(source.id);
    if (report.missingRanges.length) await deps.setSourceStatus(source.id, 'degraded', safeHead);
    else if (updated.confirmedToBlock >= safeHead || source.startBlock > safeHead) {
      await deps.setSourceStatus(source.id, 'caught_up', safeHead);
    }
  }
  return reports;
}
