import type { Pool } from 'pg';
import type { UsdPriceClient } from '../market/usdPricing.js';
import type { ApiEvent, ApiEventBus } from './events.js';
import { recomputeLaunchStats } from './launchStatsWorker.js';

export interface LiveLaunchStatsOptions {
  /** A launch is recomputed at most once per this long, however many trades it gets. */
  minIntervalMs?: number;
  /** Launches recomputed at the same time. */
  concurrency?: number;
  /** Launches waiting for a turn; beyond it the periodic stats worker is the backstop. */
  maxQueue?: number;
  recompute?: typeof recomputeLaunchStats;
  /** Where `launch.changed` goes once a launch is recomputed. Default: this process's event bus; a separate worker sends it through Postgres instead. */
  announce?: (event: ApiEvent) => void;
}

/**
 * Trades trigger a quick stats refresh. A candle worker can also request a refresh after its persisted aggregates are ready:
 * the first trade-triggered refresh may have seen a dirty candle and stored an incomplete 52-week range. Announce only after
 * recomputation so a browser refetch reads the new figures.
 */
export function startLiveLaunchStats(pool: Pool, rpcClient: UsdPriceClient, events: ApiEventBus, options: LiveLaunchStatsOptions = {}): () => void {
  const minIntervalMs = options.minIntervalMs ?? 2_000;
  const concurrency = options.concurrency ?? 2;
  const maxQueue = options.maxQueue ?? 200;
  const recompute = options.recompute ?? recomputeLaunchStats;
  const announce = options.announce ?? ((event: ApiEvent) => { events.publish(event); });
  const queued = new Map<string, { chainId: number; tokenAddress: string }>();
  const lastStarted = new Map<string, number>();
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const pump = () => {
    timer = null;
    if (stopped) return;
    const now = Date.now();
    let nextDue = Number.POSITIVE_INFINITY;
    for (const [key, launch] of queued) {
      if (running >= concurrency) break;
      const due = (lastStarted.get(key) ?? 0) + minIntervalMs;
      if (due > now) { nextDue = Math.min(nextDue, due); continue; }
      queued.delete(key);
      lastStarted.set(key, now);
      running += 1;
      void recompute(pool, rpcClient, launch.chainId, launch.tokenAddress)
        .then((found) => { if (found && !stopped) announce({ type: 'launch.changed', chainId: launch.chainId, tokenAddress: launch.tokenAddress }); })
        .catch(() => { /* the periodic stats worker catches this launch up */ })
        .finally(() => { running -= 1; schedule(0); });
    }
    if (nextDue !== Number.POSITIVE_INFINITY) schedule(nextDue - now);
    // Keep the bookkeeping small on a long-running process.
    if (lastStarted.size > 5_000) for (const [key, at] of lastStarted) if (now - at > minIntervalMs) lastStarted.delete(key);
  };
  function schedule(delayMs: number) {
    if (timer !== null || stopped) return;
    timer = setTimeout(pump, Math.max(0, delayMs));
  }

  const unsubscribe = events.subscribe((event) => {
    if ((event.type !== 'trade.created' && !(event.type === 'launch.changed' && event.refreshStats === true)) || !event.tokenAddress) return;
    const key = `${event.chainId}:${event.tokenAddress}`;
    if (!queued.has(key) && queued.size >= maxQueue) return;
    queued.set(key, { chainId: event.chainId, tokenAddress: event.tokenAddress });
    schedule(0);
  });
  return () => { stopped = true; unsubscribe(); if (timer !== null) clearTimeout(timer); };
}
