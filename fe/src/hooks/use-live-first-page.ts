'use client';

import { useEffect } from 'react';
import { TRADE_CREATED_EVENT } from './live-events';
import type { SseEventPayload } from './resource-keys';

export const LIVE_FETCH_MIN_INTERVAL_MS = 1_000;

// Runs `fetchFirstPage` as soon as a matching event (a trade by default, or `eventName`) is announced, instead of waiting for the page-wide
// router.refresh() (throttled, and it re-runs every other fetch on the page). Leading + trailing throttle:
// a busy feed costs at most one request a second. Skipped while the tab is hidden; the fallback poll catches up.
export function useLiveFirstPage(matches: (payload: SseEventPayload) => boolean, fetchFirstPage: (isStale: () => boolean) => Promise<void>, deps: readonly unknown[], eventName: string = TRADE_CREATED_EVENT): void {
  useEffect(() => {
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const run = async () => {
      lastRun = Date.now();
      try { if (!disposed) await fetchFirstPage(() => disposed); } catch { /* the page-wide refresh and the fallback poll still catch up */ }
    };
    const onTradeCreated = (event: Event) => {
      if (!matches((event as CustomEvent<SseEventPayload>).detail)) return;
      if (document.hidden || trailing !== null) return;
      const wait = LIVE_FETCH_MIN_INTERVAL_MS - (Date.now() - lastRun);
      if (wait <= 0) { void run(); return; }
      trailing = setTimeout(() => { trailing = null; void run(); }, wait);
    };
    window.addEventListener(eventName, onTradeCreated);
    return () => {
      disposed = true;
      window.removeEventListener(eventName, onTradeCreated);
      if (trailing !== null) clearTimeout(trailing);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, eventName]);
}
