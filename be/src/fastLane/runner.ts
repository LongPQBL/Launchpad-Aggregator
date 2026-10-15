import type { Pool } from 'pg';
import type { Database } from '../db/client.js';
import { applyLiveRows, type LiveEntry } from '../envioSync/incrementalSync.js';
import { classifyLog, decodeLiveLog, type FastLog } from './decode.js';
import { advanceLaneBlock, advanceLaneResumeBlock, ensureLaneVenueCoverage, initializeLaneBlock, raiseLaneVenueBridge,
  readLaneBlock, readMinimumLaneBridgeBlock, recordFastRows, removeLaneTrade } from './store.js';
import { createWatchSetLoader, EMPTY_WATCH_SET, isWatched, type WatchSet } from './watchSet.js';

/** `senders` (lower-case tx hash -> `from`) is filled when the block was read with its transactions: one call then answers every lookup. */
export interface BlockHeader { number: bigint; hash: string; timestamp: number; senders?: ReadonlyMap<string, string> }
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
  /** The clock, in ms since the epoch; injectable for tests. */
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface FastLaneStats {
  received: number; watched: number; applied: number; unresolved: number; skipped: number; removed: number; errors: number; sweeps: number;
  /** Sweep timer ticks dropped because the previous sweep was still queued or running. */
  sweepsSkipped: number;
  /** Blocks with at least one watched log, and the time spent per block on RPC lookups and on database writes (sums, in ms). */
  blocks: number; lookupMs: number; applyMs: number;
  /** RPC lookups that had to be tried again (an error, or the node did not have the block or transaction yet). */
  lookupRetries: number;
  /** Calls to the node for a block or a transaction and the total time they took (ms), retries included. */
  rpcCalls: number; rpcMs: number;
  /** The slowest single call and how many took over half a second. */
  rpcMsMax: number; rpcSlowCalls: number;
  /** Where the delay of a trade goes: from the block's timestamp to the socket delivering its log (provider side), and from the delivery to the row being written (the lane's queue, lookups, database). Worst case since start, in ms. */
  deliveryMsMax: number; queueMsMax: number;
  /** When the WebSocket last delivered a batch of logs (ms since the epoch); null before the first one. The sweep never sets it. */
  lastSocketLogAt: number | null;
}
export interface FastLane {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleLogs(logs: readonly FastLog[]): Promise<void>;
  sweepOnce(): Promise<void>;
  reloadWatchSet(): Promise<void>;
  stats(): FastLaneStats;
  /** Seconds since the WebSocket last delivered logs, or since start() when it never has. */
  socketSilentForSeconds(): number;
}

const HANDLED_KEYS_MAX = 5_000;
const CACHE_MAX = 512;
const SENDER_CACHE_MAX = 4_096;
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
  const now = options.now ?? Date.now;
  const counters: FastLaneStats = {
    received: 0, watched: 0, applied: 0, unresolved: 0, skipped: 0, removed: 0, errors: 0, sweeps: 0, sweepsSkipped: 0, blocks: 0, lookupMs: 0, applyMs: 0, lookupRetries: 0, rpcCalls: 0, rpcMs: 0, rpcMsMax: 0, rpcSlowCalls: 0, deliveryMsMax: 0, queueMsMax: 0, lastSocketLogAt: null,
  };
  let startedAt = now();
  let sweepInFlight = false;

  let watch: WatchSet = EMPTY_WATCH_SET;
  const watchLoader = createWatchSetLoader(pool, chainId);
  let lastSwept: bigint | null = null;
  const headers = new Map<string, BlockHeader>();
  const senders = new Map<string, string>();
  const arrivedAt = new Map<string, number>(); // block number -> when the socket delivered its first watched log
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
      const rpcStart = now();
      try {
        const found = await find();
        const took = now() - rpcStart;
        counters.rpcCalls += 1; counters.rpcMs += took; counters.rpcMsMax = Math.max(counters.rpcMsMax, took); if (took > 500) counters.rpcSlowCalls += 1;
        if (found !== null) return found;
      } catch { /* retried; a lookup that keeps failing skips the log */ }
      counters.lookupRetries += 1;
      if (attempt < lookupRetries - 1) await sleep(lookupRetryDelayMs);
    }
    return null;
  }
  function remember(header: BlockHeader): void {
    headers.set(header.number.toString(), header);
    trim(headers, CACHE_MAX);
    for (const [txHash, from] of header.senders ?? []) senders.set(txHash.toLowerCase(), from);
    trim(senders, SENDER_CACHE_MAX);
  }
  const pendingHeaders = new Map<string, Promise<BlockHeader | null>>();
  function getHeader(blockNumber: bigint): Promise<BlockHeader | null> {
    const key = blockNumber.toString();
    const cached = headers.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingHeaders.get(key);
    if (pending) return pending;
    const started = lookup(() => source.getBlock(blockNumber)).then((header) => {
      if (header) remember(header);
      return header;
    }).finally(() => { pendingHeaders.delete(key); });
    pendingHeaders.set(key, started);
    return started;
  }
  async function getSender(txHash: string): Promise<string | null> {
    const key = txHash.toLowerCase();
    const cached = senders.get(key);
    if (cached) return cached;
    const sender = await lookup(() => source.getTransactionSender(txHash));
    if (sender) { senders.set(key, sender); trim(senders, SENDER_CACHE_MAX); }
    return sender;
  }

  async function processBlock(blockNumber: bigint, blockLogs: FastLog[]): Promise<boolean> {
    const keyOf = (entry: FastLog) => `${entry.transactionHash.toLowerCase()}:${entry.logIndex}`;
    const candidates = blockLogs
      .map((entry) => ({ entry, cls: classifyLog(entry) }))
      .filter((item): item is { entry: FastLog; cls: NonNullable<ReturnType<typeof classifyLog>> } => item.cls !== null && isWatched(watch, item.cls))
      .filter((item) => !handled.has(keyOf(item.entry)))
      .sort((a, b) => a.entry.logIndex - b.entry.logIndex);
    counters.watched += candidates.length;
    if (candidates.length === 0) return true;
    const lookupStart = now();
    let header = await getHeader(blockNumber);
    if (!header) { counters.skipped += candidates.length; return false; }
    if (candidates.some(({ entry }) => header!.hash.toLowerCase() !== entry.blockHash.toLowerCase())) {
      // the cached header may predate a reorg: ask the node once more before calling it a mismatch
      const fresh = await lookup(() => source.getBlock(blockNumber));
      if (fresh) { header = fresh; remember(fresh); }
    }
    const current = header;
    const entries: LiveEntry[] = [];
    const keys: string[] = [];
    let complete = true;
    // Anything the block read did not already answer is asked for all at once, not one transaction after another.
    await Promise.all([...new Set(candidates.map(({ entry }) => entry.transactionHash.toLowerCase()))].map((txHash) => getSender(txHash)));
    for (const { entry } of candidates) {
      if (current.hash.toLowerCase() !== entry.blockHash.toLowerCase()) { counters.skipped += 1; complete = false; continue; }
      const from = await getSender(entry.transactionHash);
      if (!from) { counters.skipped += 1; complete = false; continue; }
      const decoded = decodeLiveLog(entry, { chainId, timestamp: current.timestamp, txFrom: from });
      if (!decoded) { counters.skipped += 1; complete = false; continue; }
      entries.push(decoded);
      keys.push(keyOf(entry));
    }
    counters.lookupMs += now() - lookupStart;
    if (entries.length === 0) return complete;
    const applyStart = now();
    const result = await applyLiveRows(db, chainId, entries);
    counters.applied += result.applied; counters.unresolved += result.unresolved; counters.skipped += result.skipped;
    if (result.outcomes.some((outcome) => outcome !== 'applied')) complete = false;
    await recordFastRows(db, chainId, entries.filter((_, index) => result.outcomes[index] === 'applied'));
    keys.forEach((key, index) => { if (result.outcomes[index] === 'applied') handled.add(key); });
    counters.blocks += 1; counters.applyMs += now() - applyStart;
    const arrived = arrivedAt.get(blockNumber.toString());
    if (arrived !== undefined) {
      const delivery = arrived - current.timestamp * 1000; // timestamps have 1 s resolution
      const queued = now() - arrived;
      counters.deliveryMsMax = Math.max(counters.deliveryMsMax, delivery); counters.queueMsMax = Math.max(counters.queueMsMax, queued);
      if (delivery > 3_000 || queued > 3_000) log('slow trade', { blockNumber: blockNumber.toString(), deliveryMs: Math.round(delivery), queueMs: Math.round(queued), trades: entries.length });
      arrivedAt.delete(blockNumber.toString());
    }
    while (handled.size > HANDLED_KEYS_MAX) handled.delete(handled.values().next().value as string);
    return complete;
  }

  async function processLogs(logs: readonly FastLog[]): Promise<boolean> {
    counters.received += logs.length;
    for (const removed of logs.filter((entry) => entry.removed)) {
      try {
        if (await removeLaneTrade(db, chainId, { txHash: removed.transactionHash, logIndex: removed.logIndex, blockHash: removed.blockHash })) counters.removed += 1;
        headers.delete(removed.blockNumber.toString());
        handled.delete(`${removed.transactionHash.toLowerCase()}:${removed.logIndex}`);
      } catch (error) { counters.errors += 1; log('could not remove a reorged trade', { error: (error as Error).message }); }
    }
    const byBlock = new Map<bigint, FastLog[]>();
    for (const entry of logs) {
      if (entry.removed) continue;
      byBlock.set(entry.blockNumber, [...(byBlock.get(entry.blockNumber) ?? []), entry]);
    }
    let complete = true;
    for (const blockNumber of [...byBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      try { if (!await processBlock(blockNumber, byBlock.get(blockNumber)!)) complete = false; }
      catch (error) { complete = false; counters.errors += 1; log('could not apply a block of trades', { blockNumber: blockNumber.toString(), error: (error as Error).message }); }
    }
    return complete;
  }

  async function sweep(): Promise<void> {
    const head = await source.getBlockNumber();
    const to = head - sweepLagBlocks;
    if (lastSwept === null) {
      const saved = await readLaneBlock(db, chainId);
      if (saved !== null) lastSwept = saved;
      else {
        // Every venue's Envio bridge was persisted when it entered the watch set. Starting at the
        // minimum bridge makes the first lane sweep contiguous with the canonical rows already in DB.
        const bridge = await readMinimumLaneBridgeBlock(db, chainId);
        lastSwept = bridge !== null && bridge < to ? bridge : to;
        await initializeLaneBlock(db, chainId, lastSwept);
      }
    }
    if (to <= lastSwept) return;
    const from = lastSwept + 1n;
    if (to - from + 1n > maxGapBlocks) {
      log('gap larger than the limit; skipping ahead, Envio covers it', { from: from.toString(), to: to.toString() });
      // Move the restart cursor, but keep the trusted watermark behind and require Envio to bridge
      // this interval for every venue before later lane blocks can be used as complete coverage.
      lastSwept = to;
      await advanceLaneResumeBlock(db, chainId, to);
      await raiseLaneVenueBridge(db, chainId, to);
      return;
    }
    for (let start = from; start <= to; start += sweepChunkBlocks) {
      const end = start + sweepChunkBlocks - 1n < to ? start + sweepChunkBlocks - 1n : to;
      const logs = await source.getLogs(start, end); // the slow part runs outside the queue, so a live log never waits behind it
      const byBlock = new Map<bigint, FastLog[]>();
      for (const entry of logs) byBlock.set(entry.blockNumber, [...(byBlock.get(entry.blockNumber) ?? []), entry]);
      const blockNumbers = [...byBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const headerBlocks = blockNumbers.filter((blockNumber) => byBlock.get(blockNumber)!.some((entry) => {
        if (entry.removed) return false;
        const cls = classifyLog(entry);
        return cls !== null && isWatched(watch, cls);
      }));
      let prefetchIndex = 0;
      await Promise.all(Array.from({ length: Math.min(8, headerBlocks.length) }, async () => {
        while (prefetchIndex < headerBlocks.length) await getHeader(headerBlocks[prefetchIndex++]!);
      }));
      // A whole multi-thousand-block chunk can contain minutes of sequential RPC work. Queue one
      // block at a time so live socket batches can run between historical blocks instead of waiting
      // behind the complete backfill chunk.
      for (const blockNumber of blockNumbers) {
        let complete = false;
        await enqueue(async () => { complete = await processLogs(byBlock.get(blockNumber)!); });
        if (!complete) return;
      }
    }
    lastSwept = to;
    await advanceLaneBlock(db, chainId, to);
    counters.sweeps += 1;
  }

  async function reloadWatchSet(): Promise<void> {
    const snapshot = await watchLoader.refresh();
    await ensureLaneVenueCoverage(db, chainId, snapshot.addedVenues, await readLaneBlock(db, chainId));
    watch = snapshot;
  }

  // The WebSocket path: the only one that proves the subscription is alive.
  function handleSocketLogs(logs: readonly FastLog[]): Promise<void> {
    counters.lastSocketLogAt = now();
    // Start reading the block of every watched log right away; the queue may still be busy with an earlier block, and the reads of
    // consecutive blocks then overlap instead of following one another (~230 ms each).
    const blocks = new Set<bigint>();
    for (const entry of logs) {
      if (entry.removed) continue;
      const cls = classifyLog(entry);
      if (cls !== null && isWatched(watch, cls) && !handled.has(`${entry.transactionHash.toLowerCase()}:${entry.logIndex}`)) blocks.add(entry.blockNumber);
    }
    const arrival = now();
    for (const blockNumber of blocks) {
      if (!arrivedAt.has(blockNumber.toString())) arrivedAt.set(blockNumber.toString(), arrival);
      void getHeader(blockNumber);
    }
    trim(arrivedAt, CACHE_MAX);
    return enqueue(async () => { await processLogs(logs); });
  }

  async function sweepSafely(): Promise<void> {
    try { await sweep(); } catch (error) { counters.errors += 1; log('sweep failed', { error: (error as Error).message }); }
  }

  // A slow RPC can make one sweep outlast the timer: never queue a second one behind it.
  function sweepTick(): void {
    if (sweepInFlight) { counters.sweepsSkipped += 1; return; }
    sweepInFlight = true;
    void sweepSafely().finally(() => { sweepInFlight = false; });
  }

  return {
    async start() {
      startedAt = now();
      await reloadWatchSet();
      lastSwept = await readLaneBlock(db, chainId);
      unsubscribe = source.subscribeLogs((logs) => { void handleSocketLogs(logs); }, (error) => { counters.errors += 1; log('log subscription error', { error: error.message }); });
      timers.push(setInterval(() => { void reloadWatchSet().catch((error) => log('watch set refresh failed', { error: (error as Error).message })); }, watchRefreshEveryMs));
      timers.push(setInterval(sweepTick, sweepEveryMs));
    },
    async stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      unsubscribe?.();
      unsubscribe = null;
      await queue;
    },
    handleLogs: handleSocketLogs,
    sweepOnce: sweepSafely,
    reloadWatchSet,
    stats: () => ({ ...counters }),
    socketSilentForSeconds: () => Math.max(0, (now() - (counters.lastSocketLogAt ?? startedAt)) / 1000),
  };
}
