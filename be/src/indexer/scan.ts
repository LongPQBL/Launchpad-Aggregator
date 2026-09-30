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

export function scanChunkBounds(maxChunk: bigint): Pick<ScanDeps, 'initialChunk' | 'maxChunk'> {
  if (maxChunk < 1n || maxChunk > 500_000n) throw new Error('Invalid RPC log range cap');
  return { initialChunk: maxChunk < 10_000n ? maxChunk : 10_000n, maxChunk };
}

function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' — caused by: ');
}

export function safeErrorMessage(error: unknown): string {
  return errorMessage(error).replace(/https?:\/\/[^\s"'\\]+/g, '[RPC endpoint]').slice(0, 1_024);
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

// Some rate-limit responses report exactly how long the window has left (e.g. "limit will
// reset in 60 seconds") — honor that instead of the short exponential backoff, which gives up
// long before a real reset window clears and leaves a gap that only a later manual rescan fills.
// This RPC's 429 sometimes omits the reset time and just says "Too Many Requests" — real
// evidence (2026-09-30) shows the underlying window is still ~60s even then, so a rate-limit
// match with no explicit reset time defaults to the same ~60s wait rather than a short backoff
// that exhausts every retry long before the window actually clears.
// Exported so one-off scripts that hit this RPC directly (e.g. backfillTraderAddress.ts) reuse
// the same wait instead of a shorter backoff that crashes on the same message.
export function retryDelayMs(message: string, attempt: number): number {
  const resetMatch = message.match(/reset in (\d+)\s*seconds?/i);
  if (resetMatch) return Number(resetMatch[1]) * 1000 + 1_000;
  if (isTransient(message)) return 65_000;
  return Math.min(250 * 2 ** attempt, 8_000);
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
          report.missingRanges.push({ fromBlock, toBlock, reason: safeErrorMessage(error) });
          return report;
        }
        if (isRangeLimit(message) && chunk > deps.minChunk) {
          chunk = chunk / 2n > deps.minChunk ? chunk / 2n : deps.minChunk;
          break;
        }
        if ((isTransient(message) || isRangeLimit(message)) && attempt < deps.maxRetries) {
          await deps.sleep(retryDelayMs(message, attempt));
          attempt++;
          continue;
        }
        report.missingRanges.push({ fromBlock, toBlock, reason: safeErrorMessage(error) });
        return report;
      }
    }
    if (!logs) continue;
    let saved = false;
    let saveAttempt = 0;
    while (!saved) {
      try {
        const batch = await deps.decodeLogs(logs, source);
        await deps.saveIndexBatch(source.id, fromBlock, toBlock, batch);
        saved = true;
      } catch (error) {
        const message = errorMessage(error);
        // decodeLogs can make its own RPC calls (e.g. per-token metadata eth_call for a newly
        // discovered launch), so a transient failure here needs the same retry as getLogs above —
        // a genuine decode error (bad data, unknown pool, etc.) still fails immediately.
        if ((isTransient(message) || isRangeLimit(message)) && saveAttempt < deps.maxRetries) {
          await deps.sleep(retryDelayMs(message, saveAttempt));
          saveAttempt++;
          continue;
        }
        report.missingRanges.push({ fromBlock, toBlock, reason: safeErrorMessage(error) });
        return report;
      }
    }
    report.committedRanges.push({ fromBlock, toBlock });
    fromBlock = toBlock + 1n;
    if (chunk < deps.maxChunk) {
      const step = chunk / 4n > 0n ? chunk / 4n : 1n;
      chunk = chunk + step < deps.maxChunk ? chunk + step : deps.maxChunk;
    }
  }
  return report;
}
