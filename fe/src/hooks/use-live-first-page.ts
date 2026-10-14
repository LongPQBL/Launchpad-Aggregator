'use client';

import { useEffect } from 'react';
import { TRADE_CREATED_EVENT } from './live-events';
import type { SseEventPayload } from './resource-keys';

export const LIVE_FETCH_MIN_INTERVAL_MS = 1_000;

// Runs `fetchFirstPage` as soon as a matching event (a trade by default, or `eventName`) is announced, instead of waiting for the page-wide
// router.refresh() (throttled, and it re-runs every other fetch on the page). Leading + trailing throttle:
// a busy feed costs at most one request a second. Skipped while the tab is hidden, with one catch-up fetch when it becomes visible.
export function useLiveFirstPage(matches: (payload: SseEventPayload) => boolean, fetchFirstPage: (isStale: () => boolean) => Promise<void>, deps: readonly unknown[], eventName: string | readonly string[] = TRADE_CREATED_EVENT,
  /** Shortest time between two fetches; a request the API rate-limits more tightly (RPC-backed reads) asks for more than a second. */
  minIntervalMs: number = LIVE_FETCH_MIN_INTERVAL_MS): void {
  useEffect(() => {
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let missedWhileHidden = false;
    const run = async () => {
      lastRun = Date.now();
      try { if (!disposed) await fetchFirstPage(() => disposed); } catch { /* the page-wide refresh and the fallback poll still catch up */ }
    };
    const onTradeCreated = (event: Event) => {
      if (!matches((event as CustomEvent<SseEventPayload>).detail)) return;
      if (document.hidden) { missedWhileHidden = true; return; }
      if (trailing !== null) return;
      const wait = minIntervalMs - (Date.now() - lastRun);
      if (wait <= 0) { void run(); return; }
      trailing = setTimeout(() => { trailing = null; void run(); }, wait);
    };
    // A hidden tab skips events; it catches up once, as soon as it is visible again.
    const onVisible = () => {
      if (document.hidden || !missedWhileHidden) return;
      missedWhileHidden = false;
      void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    const names = typeof eventName === 'string' ? [eventName] : eventName;
    for (const name of names) window.addEventListener(name, onTradeCreated);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      for (const name of names) window.removeEventListener(name, onTradeCreated);
      if (trailing !== null) clearTimeout(trailing);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, typeof eventName === 'string' ? eventName : eventName.join('|'), minIntervalMs]);
}
