import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { applyLiveRows, type LiveEntry } from '../envioSync/incrementalSync.js';
import { classifyLog, decodeLiveLog, type FastLog } from './decode.js';
import { advanceLaneBlock, readLaneBlock, recordFastRows, removeLaneTrade } from './store.js';
import { EMPTY_WATCH_SET, isWatched, loadWatchSet, type WatchSet } from './watchSet.js';

export interface BlockHeader { number: bigint; hash: string; timestamp: number }
export interface LaneChainSource {
  getBlock(blockNumber: bigint): Promise<BlockHeader | null>;
  getTransactionSender(txHash: string): Promise<string | null>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<FastLog[]>;
  getBlockNumber(): Promise<bigint>;
  subscribeLogs(onLogs: (logs: FastLog[]) => void, onError: (error: Error) => void): () => void;
}
export interface FastLaneOptions {
  chainId: number;
  sweepEveryMs?: number; watchRefreshEveryMs?: number; sweepLagBlocks?: bigint; maxGapBlocks?: bigint; sweepChunkBlocks?: bigint;
  lookupRetries?: number; lookupRetryDelayMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface FastLaneStats { received: number; watched: number; applied: number; unresolved: number; skipped: number; removed: number; errors: number; sweeps: number }
export interface FastLane {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleLogs(logs: readonly FastLog[]): Promise<void>;
  sweepOnce(): Promise<void>;
  reloadWatchSet(): Promise<void>;
  stats(): FastLaneStats;
}

const HANDLED_KEYS_MAX = 5_000;
const CACHE_MAX = 512;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as K);
}

export function createFastLane(deps: { source: LaneChainSource; db: Database; pool: Pool }, options: FastLaneOptions): FastLane {
  const { source, db, pool } = deps;
  const { chainId } = options;
  const sweepEveryMs = options.sweepEveryMs ?? 10_000;
  const watchRefreshEveryMs = options.watchRefreshEveryMs ?? 10_000;
  const sweepLagBlocks = options.sweepLagBlocks ?? 2n;
  const maxGapBlocks = options.maxGapBlocks ?? 20_000n;
  const sweepChunkBlocks = options.sweepChunkBlocks ?? 2_000n;
  const lookupRetries = options.lookupRetries ?? 3;
  const lookupRetryDelayMs = options.lookupRetryDelayMs ?? 100;
  const log = options.log ?? (() => {});
  const counters: FastLaneStats = { received: 0, watched: 0, applied: 0, unresolved: 0, skipped: 0, removed: 0, errors: 0, sweeps: 0 };

  let watch: WatchSet = EMPTY_WATCH_SET;
  let lastSwept: bigint | null = null;
  const headers = new Map<string, BlockHeader>();
  const senders = new Map<string, string>();
  const handled = new Set<string>(); // `${txHash}:${logIndex}` of logs this process already applied
  let queue: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];

  // Everything that touches the database runs one task at a time, in arrival order.
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch((error) => { counters.errors += 1; log('fast lane task failed', { error: (error as Error).message }); });
    return queue;
  }

  async function lookup<T>(find: () => Promise<T | null>): Promise<T | null> {
    for (let attempt = 0; attempt < lookupRetries; attempt += 1) {
      try {
        const found = await find();
        if (found !== null) return found;
      } catch { /* retried; a lookup that keeps failing skips the log */ }
      if (attempt < lookupRetries - 1) await sleep(lookupRetryDelayMs);
    }
    return null;
  }
  async function getHeader(blockNumber: bigint): Promise<BlockHeader | null> {
    const cached = headers.get(blockNumber.toString());
    if (cached) return cached;
    const header = await lookup(() => source.getBlock(blockNumber));
    if (header) { headers.set(blockNumber.toString(), header); trim(headers, CACHE_MAX); }
    return header;
  }
  async function getSender(txHash: string): Promise<string | null> {
    const cached = senders.get(txHash);
    if (cached) return cached;
    const sender = await lookup(() => source.getTransactionSender(txHash));
    if (sender) { senders.set(txHash, sender); trim(senders, CACHE_MAX); }
    return sender;
  }

  async function processBlock(blockNumber: bigint, blockLogs: FastLog[]): Promise<void> {
    const keyOf = (entry: FastLog) => `${entry.transactionHash.toLowerCase()}:${entry.logIndex}`;
    const candidates = blockLogs
      .map((entry) => ({ entry, cls: classifyLog(entry) }))
      .filter((item): item is { entry: FastLog; cls: NonNullable<ReturnType<typeof classifyLog>> } => item.cls !== null && isWatched(watch, item.cls))
      .filter((item) => !handled.has(keyOf(item.entry)))
      .sort((a, b) => a.entry.logIndex - b.entry.logIndex);
    counters.watched += candidates.length;
    if (candidates.length === 0) return;
    const header = await getHeader(blockNumber);
    if (!header) { counters.skipped += candidates.length; return; }
    const entries: LiveEntry[] = [];
    const keys: string[] = [];
    for (const { entry } of candidates) {
      if (header.hash.toLowerCase() !== entry.blockHash.toLowerCase()) { counters.skipped += 1; continue; }
      const from = await getSender(entry.transactionHash);
      if (!from) { counters.skipped += 1; continue; }
      const decoded = decodeLiveLog(entry, { chainId, timestamp: header.timestamp, txFrom: from });
      if (!decoded) { counters.skipped += 1; continue; }
      entries.push(decoded);
      keys.push(keyOf(entry));
    }
    if (entries.length === 0) return;
    const result = await applyLiveRows(db, chainId, entries);
    counters.applied += result.applied; counters.unresolved += result.unresolved; counters.skipped += result.skipped;
    await recordFastRows(db, chainId, entries.filter((_, index) => result.outcomes[index] === 'applied'));
    keys.forEach((key, index) => { if (result.outcomes[index] === 'applied') handled.add(key); });
    while (handled.size > HANDLED_KEYS_MAX) handled.delete(handled.values().next().value as string);
    await advanceLaneBlock(db, chainId, blockNumber);
  }

  async function processLogs(logs: readonly FastLog[]): Promise<void> {
    counters.received += logs.length;
    for (const removed of logs.filter((entry) => entry.removed)) {
      try {
        if (await removeLaneTrade(db, chainId, { txHash: removed.transactionHash, logIndex: removed.logIndex, blockHash: removed.blockHash })) counters.removed += 1;
        handled.delete(`${removed.transactionHash.toLowerCase()}:${removed.logIndex}`);
      } catch (error) { counters.errors += 1; log('could not remove a reorged trade', { error: (error as Error).message }); }
    }
    const byBlock = new Map<bigint, FastLog[]>();
    for (const entry of logs) {
      if (entry.removed) continue;
      byBlock.set(entry.blockNumber, [...(byBlock.get(entry.blockNumber) ?? []), entry]);
    }
    for (const blockNumber of [...byBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      try { await processBlock(blockNumber, byBlock.get(blockNumber)!); }
      catch (error) { counters.errors += 1; log('could not apply a block of trades', { blockNumber: blockNumber.toString(), error: (error as Error).message }); }
    }
  }

  async function sweep(): Promise<void> {
    const head = await source.getBlockNumber();
    const to = head - sweepLagBlocks;
    if (lastSwept === null) lastSwept = (await readLaneBlock(db, chainId)) ?? to; // a lane that never ran starts here, it does not backfill
    if (to <= lastSwept) return;
    const from = lastSwept + 1n;
    if (to - from + 1n > maxGapBlocks) {
      log('gap larger than the limit; skipping ahead, Envio covers it', { from: from.toString(), to: to.toString() });
      lastSwept = to;
      await advanceLaneBlock(db, chainId, to);
      return;
    }
    for (let start = from; start <= to; start += sweepChunkBlocks) {
      const end = start + sweepChunkBlocks - 1n < to ? start + sweepChunkBlocks - 1n : to;
      await processLogs(await source.getLogs(start, end));
    }
    lastSwept = to;
    await advanceLaneBlock(db, chainId, to);
    counters.sweeps += 1;
  }

  async function reloadWatchSet(): Promise<void> {
    watch = await loadWatchSet(pool, chainId);
  }

  return {
    async start() {
      await reloadWatchSet();
      lastSwept = await readLaneBlock(db, chainId);
      unsubscribe = source.subscribeLogs((logs) => { void enqueue(() => processLogs(logs)); }, (error) => { counters.errors += 1; log('log subscription error', { error: error.message }); });
      timers.push(setInterval(() => { void reloadWatchSet().catch((error) => log('watch set refresh failed', { error: (error as Error).message })); }, watchRefreshEveryMs));
      timers.push(setInterval(() => { void enqueue(sweep); }, sweepEveryMs));
    },
    async stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      unsubscribe?.();
      unsubscribe = null;
      await queue;
    },
    handleLogs: (logs) => enqueue(() => processLogs(logs)),
    sweepOnce: () => enqueue(sweep),
    reloadWatchSet,
    stats: () => ({ ...counters }),
  };
}
