import type { SourceCursor } from '../domain/types.js';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface CoverageGap { sourceId: string; fromBlock: bigint; toBlock: bigint; reason: string }
export interface Coverage { complete: boolean; pendingSourceIds: string[]; missingRanges: CoverageGap[] }
export interface ReconciliationResult { sourceId: string; complete: boolean; indexedCount: number; independentCount: number; difference: number }

export function getCoverage(sourceIds: readonly string[], cursors: readonly SourceCursor[], missingRanges: readonly CoverageGap[], requiredToBlock: bigint): Coverage {
  const byId = new Map(cursors.map((cursor) => [cursor.sourceId, cursor]));
  const pendingSourceIds = sourceIds.filter((id) => {
    const cursor = byId.get(id);
    return !cursor || cursor.status !== 'caught_up' || cursor.confirmedToBlock < requiredToBlock;
  });
  const requested = new Set(sourceIds);
  const relevantGaps = missingRanges.filter((range) => requested.has(range.sourceId) && range.fromBlock <= requiredToBlock);
  return { complete: pendingSourceIds.length === 0 && relevantGaps.length === 0, pendingSourceIds, missingRanges: relevantGaps };
}

export function reconcileLaunchCounts(factory: FactorySource, indexedCount: number, independentCount: number): ReconciliationResult {
  if (!Number.isSafeInteger(indexedCount) || !Number.isSafeInteger(independentCount) || indexedCount < 0 || independentCount < 0) {
    throw new Error('Invalid launch counts');
  }
  return { sourceId: factory.id, complete: indexedCount === independentCount, indexedCount,
    independentCount, difference: independentCount - indexedCount };
}

export interface CountedLaunchLog { blockNumber: bigint; transactionHash: string; logIndex: number }

export async function scanFactoryLaunchCount(factory: FactorySource, toBlock: bigint, chunkBlocks: bigint,
  getLaunchLogs: (fromBlock: bigint, toBlock: bigint) => Promise<readonly CountedLaunchLog[]>): Promise<number> {
  if (chunkBlocks < 2n) throw new Error('Independent scan chunk must allow one-block overlap');
  if (toBlock < factory.startBlock) return 0;
  const observed = new Set<string>();
  let fromBlock = factory.startBlock;
  while (fromBlock <= toBlock) {
    const end = fromBlock + chunkBlocks - 1n < toBlock ? fromBlock + chunkBlocks - 1n : toBlock;
    const logs = await getLaunchLogs(fromBlock, end);
    for (const log of logs) {
      if (log.blockNumber < fromBlock || log.blockNumber > end) throw new Error('Independent scan returned a log outside the requested range');
      observed.add(`${log.blockNumber}:${log.transactionHash.toLowerCase()}:${log.logIndex}`);
    }
    if (end === toBlock) break;
    fromBlock = end;
  }
  return observed.size;
}
