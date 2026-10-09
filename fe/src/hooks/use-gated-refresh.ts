'use client';

import { useCallback, useEffect, useRef } from 'react';

export const MIN_REFRESH_INTERVAL_MS = 3_000;

// router.refresh() re-runs every server fetch on the page (transactions, candles, pools, venue),
// so a busy token's stream of realtime events must not translate one-to-one into full page
// refreshes. Two rules: at most one refresh per MIN_REFRESH_INTERVAL_MS (a trailing run catches
// anything that arrived inside the window), and none while the tab is hidden — a hidden tab
// remembers it is stale and refreshes once when it becomes visible again.
export function useGatedRefresh(refresh: () => void): () => void {
  const refreshRef = useRef(refresh);
  const lastRunRef = useRef(0);
  const stalePendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  const run = useCallback(() => {
    lastRunRef.current = Date.now();
    stalePendingRef.current = false;
    refreshRef.current();
  }, []);

  const request = useCallback(() => {
    if (document.hidden) {
      stalePendingRef.current = true;
      return;
    }
    if (timerRef.current !== null) return;
    const wait = MIN_REFRESH_INTERVAL_MS - (Date.now() - lastRunRef.current);
    if (wait <= 0) {
      run();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (document.hidden) stalePendingRef.current = true;
      else run();
    }, wait);
  }, [run]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && stalePendingRef.current) request();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [request]);

  return request;
}
