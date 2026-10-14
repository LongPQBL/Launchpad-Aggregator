import type { Pool } from 'pg';
import { decodeEventLog, parseAbiItem } from 'viem';
import { upsertPriceRounds } from '../market/quotePricing/priceRounds.js';

export const answerUpdatedEvent = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)');

export interface OracleLog {
  address: string; topics: readonly string[]; data: string; blockNumber: bigint; logIndex: number; removed?: boolean;
}
export interface OracleSource {
  /** `decimals()` of an aggregator contract. */
  readDecimals(aggregator: string): Promise<number>;
  /** Subscribes to `AnswerUpdated` emitted by exactly these aggregator addresses. */
  subscribeAnswerUpdated(addresses: readonly string[], onLogs: (logs: OracleLog[]) => void, onError: (error: Error) => void): () => void;
}
export interface OracleRoundsStats { aggregators: number; rounds: number; removed: number; ignored: number; errors: number }
export interface OracleRounds {
  start(): Promise<void>;
  /** Re-reads the verified feeds and resubscribes when the set of aggregators changed. */
  refresh(): Promise<void>;
  handleLogs(logs: readonly OracleLog[]): Promise<void>;
  stop(): void;
  stats(): OracleRoundsStats;
}

interface Known { feed: string; decimals: number }

/**
 * Stores a verified feed's new round as soon as the aggregator emits it, instead of waiting for the price worker's next backfill window: a trade's
 * USD value is its quote amount times the last round at or before the trade (and not older than 24 h), so a chain whose rounds stop arriving shows
 * no USD at all for new trades. Uses the same `upsertPriceRounds` as the worker (volume rebuilds included), then tells every page the prices changed.
 */
export function createOracleRounds(deps: { source: OracleSource; pool: Pool; chainId: number; log?: (message: string, fields?: Record<string, unknown>) => void },
  options: { refreshEveryMs?: number } = {}): OracleRounds {
  const { source, pool, chainId } = deps;
  const log = deps.log ?? (() => {});
  const refreshEveryMs = options.refreshEveryMs ?? 600_000;
  const counters: OracleRoundsStats = { aggregators: 0, rounds: 0, removed: 0, ignored: 0, errors: 0 };
  let known = new Map<string, Known>(); // lower-case aggregator address -> feed
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const decimalsCache = new Map<string, number>();

  async function load(): Promise<Map<string, Known>> {
    const result = await pool.query(
      `SELECT feed_address, aggregator_address FROM quote_usd_feeds
       WHERE chain_id = $1 AND verification_status = 'verified' AND aggregator_address IS NOT NULL`, [chainId]);
    const next = new Map<string, Known>();
    for (const row of result.rows as { feed_address: string; aggregator_address: string }[]) {
      const aggregator = row.aggregator_address.toLowerCase();
      try {
        let decimals = decimalsCache.get(aggregator);
        if (decimals === undefined) { decimals = await source.readDecimals(aggregator); decimalsCache.set(aggregator, decimals); }
        next.set(aggregator, { feed: row.feed_address.toLowerCase(), decimals });
      } catch (error) { counters.errors += 1; log('could not read the decimals of an aggregator; skipped until the next refresh', { error: (error as Error).message }); }
    }
    return next;
  }

  const sameSet = (a: Map<string, Known>, b: Map<string, Known>) => a.size === b.size && [...a.keys()].every((key) => b.has(key));

  function subscribe(): void {
    unsubscribe?.();
    unsubscribe = null;
    counters.aggregators = known.size;
    if (known.size === 0) return;
    unsubscribe = source.subscribeAnswerUpdated([...known.keys()].sort(), (logs) => { void handleLogs(logs); },
      (error) => { counters.errors += 1; log('oracle subscription error', { error: error.message }); });
  }

  async function handleLogs(logs: readonly OracleLog[]): Promise<void> {
    let stored = 0;
    for (const entry of logs) {
      const feed = known.get(entry.address.toLowerCase());
      if (!feed) { counters.ignored += 1; continue; }
      try {
        const decoded = decodeEventLog({ abi: [answerUpdatedEvent], data: entry.data as `0x${string}`, topics: [...entry.topics] as [`0x${string}`, ...`0x${string}`[]], strict: true });
        if (entry.removed) {
          await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1 AND feed_address = $2 AND round_id = $3', [chainId, feed.feed, decoded.args.roundId.toString()]);
          counters.removed += 1;
          continue;
        }
        if (decoded.args.current <= 0n) { counters.ignored += 1; continue; }
        stored += await upsertPriceRounds(pool, chainId, feed.feed, [{
          roundId: decoded.args.roundId, answerRaw: decoded.args.current, decimals: feed.decimals,
          startedAt: Number(decoded.args.updatedAt), updatedAt: Number(decoded.args.updatedAt), blockNumber: entry.blockNumber, logIndex: entry.logIndex,
        }]);
      } catch (error) { counters.errors += 1; log('could not store an oracle round', { error: (error as Error).message }); }
    }
    counters.rounds += stored;
    if (stored > 0) {
      try { await pool.query('SELECT pg_notify($1, $2)', ['launchpad_events', JSON.stringify({ type: 'coverage.changed', chainId })]); } catch { /* the pages' own retry catches up */ }
    }
  }

  async function refresh(): Promise<void> {
    const next = await load();
    if (!sameSet(known, next) || unsubscribe === null) { known = next; subscribe(); } else known = next;
  }

  return {
    async start() {
      await refresh();
      timer = setInterval(() => { void refresh().catch((error) => { counters.errors += 1; log('oracle refresh failed', { error: (error as Error).message }); }); }, refreshEveryMs);
    },
    refresh,
    handleLogs,
    stop() { if (timer) clearInterval(timer); timer = null; unsubscribe?.(); unsubscribe = null; },
    stats: () => ({ ...counters }),
  };
}
