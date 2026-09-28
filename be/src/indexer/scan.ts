import type { AbiEvent, Address, Log } from 'viem';
import type { IndexBatch, SourceCursor } from '../domain/types.js';

export interface LogSource {
  id: string;
  chainId: number;
  startBlock: bigint;
  addresses: readonly Address[];
  events: readonly AbiEvent[];
}

export interface MissingRange {
  fromBlock: bigint;
  toBlock: bigint;
  reason: string;
}

export interface ScanReport {
  sourceId: string;
  committedRanges: Array<{ fromBlock: bigint; toBlock: bigint }>;
  missingRanges: MissingRange[];
}

export interface ScanDeps {
  initialChunk: bigint;
  maxChunk: bigint;
  minChunk: bigint;
  maxRetries: number;
  getCursor(sourceId: string): Promise<SourceCursor>;
  getLogs(source: LogSource, fromBlock: bigint, toBlock: bigint): Promise<readonly Log[]>;
  decodeLogs(logs: readonly Log[], source: LogSource): Promise<IndexBatch>;
  saveIndexBatch(sourceId: string, fromBlock: bigint, toBlock: bigint, batch: IndexBatch): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHistoricalGap(message: string): boolean {
  return /historical state|missing trie node|pruned|archive.*required/i.test(message);
}

function isRangeLimit(message: string): boolean {
  return /timed out|timeout|too many logs|block range|response size|query limit/i.test(message);
}

function isTransient(message: string): boolean {
  return /429|rate limit|too many requests|503|502|network|econnreset|temporarily unavailable/i.test(message);
}

export async function scanToHead(source: LogSource, safeHead: bigint, deps: ScanDeps): Promise<ScanReport> {
  if (deps.minChunk < 1n || deps.initialChunk < deps.minChunk || deps.maxChunk < deps.initialChunk || deps.maxRetries < 0) {
    throw new Error('Invalid scan configuration');
  }
  const cursor = await deps.getCursor(source.id);
  if (cursor.chainId !== source.chainId) throw new Error('Source chain does not match stored cursor');
  const report: ScanReport = { sourceId: source.id, committedRanges: [], missingRanges: [] };
  let fromBlock = cursor.scannedToBlock + 1n > source.startBlock ? cursor.scannedToBlock + 1n : source.startBlock;
  let chunk = deps.initialChunk;
  while (fromBlock <= safeHead) {
    const toBlock = fromBlock + chunk - 1n < safeHead ? fromBlock + chunk - 1n : safeHead;
    let logs: readonly Log[] | undefined;
    let attempt = 0;
    while (!logs) {
      try {
        logs = await deps.getLogs(source, fromBlock, toBlock);
      } catch (error) {
        const message = errorMessage(error);
        if (isHistoricalGap(message)) {
          report.missingRanges.push({ fromBlock, toBlock, reason: message });
          return report;
        }
        if (isRangeLimit(message) && chunk > deps.minChunk) {
          chunk = chunk / 2n > deps.minChunk ? chunk / 2n : deps.minChunk;
          break;
        }
        if ((isTransient(message) || isRangeLimit(message)) && attempt < deps.maxRetries) {
          await deps.sleep(Math.min(250 * 2 ** attempt, 2_000));
          attempt++;
          continue;
        }
        report.missingRanges.push({ fromBlock, toBlock, reason: message });
        return report;
      }
    }
    if (!logs) continue;
    const batch = await deps.decodeLogs(logs, source);
    await deps.saveIndexBatch(source.id, fromBlock, toBlock, batch);
    report.committedRanges.push({ fromBlock, toBlock });
    fromBlock = toBlock + 1n;
    if (chunk < deps.maxChunk) {
      const step = chunk / 4n > 0n ? chunk / 4n : 1n;
      chunk = chunk + step < deps.maxChunk ? chunk + step : deps.maxChunk;
    }
  }
  return report;
}
