'use client';

import { useEffect, useRef, useState } from 'react';
import { matchesResourceKeys, type SseEventPayload } from './resource-keys';

export type { SseEventPayload };
export { chainResourceKey, launchResourceKey } from './resource-keys';

export type LiveStatus = 'connecting' | 'live' | 'polling';

const SSE_EVENT_TYPES = ['launch.changed', 'trade.created', 'coverage.changed'] as const;
const COALESCE_WINDOW_MS = 300;
const POLL_INTERVAL_MS = 15_000;
// A `pending` trade USD value (verified feed, round not backfilled yet) resolves via a
// background job with no SSE event of its own — no `trade.created`/`launch.changed` fires when
// the round backfill completes. Retry a few times at a shorter interval, then give up; this is
// deliberately bounded, not an open-ended poll, so a job that never completes doesn't poll forever.
const PENDING_RETRY_INTERVAL_MS = 5_000;
const MAX_PENDING_RETRIES = 6;

const NEXT_PUBLIC_BE_API_URL = process.env.NEXT_PUBLIC_BE_API_URL ?? 'http://127.0.0.1:3001';

export interface UseLiveRefreshOptions {
  retryWhilePending?: boolean;
}

export function useLiveRefresh(resourceKeys: readonly string[], refresh: () => void, options?: UseLiveRefreshOptions): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const refreshRef = useRef(refresh);
  const resourceKeysRef = useRef(resourceKeys);
  useEffect(() => {
    refreshRef.current = refresh;
    resourceKeysRef.current = resourceKeys;
  });
  const key = resourceKeys.join(',');
  const retryWhilePending = options?.retryWhilePending ?? false;

  // Independent of the SSE connection/outage-polling effect below — this is a fixed-count retry
  // schedule, not a fallback for a dropped connection, so it runs even while SSE reports 'live'.
  useEffect(() => {
    if (!retryWhilePending) return;
    let retriesLeft = MAX_PENDING_RETRIES;
    const timer = setInterval(() => {
      retriesLeft -= 1;
      refreshRef.current();
      if (retriesLeft <= 0) clearInterval(timer);
    }, PENDING_RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [retryWhilePending]);

  useEffect(() => {
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let hadOutage = false;

    function scheduleRefresh(): void {
      if (coalesceTimer !== null) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        refreshRef.current();
      }, COALESCE_WINDOW_MS);
    }

    function startPolling(): void {
      setStatus('polling');
      hadOutage = true;
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => refreshRef.current(), POLL_INTERVAL_MS);
    }

    function stopPolling(): void {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    const source = new EventSource(new URL('/v1/events', NEXT_PUBLIC_BE_API_URL));

    source.onopen = () => {
      setStatus('live');
      stopPolling();
      // Spec §7: "nếu SSE mất kết nối, FE tải lại dữ liệu" — events published during the outage
      // were never delivered (no Last-Event-ID replay), so catch up once on reconnect.
      if (hadOutage) {
        hadOutage = false;
        scheduleRefresh();
      }
    };
    source.onerror = () => {
      startPolling();
    };

    const onSseEvent = (event: { data: string }): void => {
      let payload: SseEventPayload;
      try {
        payload = JSON.parse(event.data) as SseEventPayload;
      } catch {
        return;
      }
      if (matchesResourceKeys(payload, resourceKeysRef.current)) scheduleRefresh();
    };

    for (const type of SSE_EVENT_TYPES) source.addEventListener(type, onSseEvent);

    return () => {
      source.close();
      stopPolling();
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
    };
  }, [key]);

  return status;
}
