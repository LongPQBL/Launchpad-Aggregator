'use client';

import { useEffect, useRef, useState } from 'react';
import { matchesResourceKeys, type SseEventPayload } from './resource-keys';

export type { SseEventPayload };
export { chainResourceKey, launchResourceKey } from './resource-keys';

export type LiveStatus = 'connecting' | 'live' | 'polling';

const SSE_EVENT_TYPES = ['launch.changed', 'trade.created', 'coverage.changed'] as const;
const COALESCE_WINDOW_MS = 300;
const POLL_INTERVAL_MS = 15_000;

const NEXT_PUBLIC_BE_API_URL = process.env.NEXT_PUBLIC_BE_API_URL ?? 'http://127.0.0.1:3001';

export function useLiveRefresh(resourceKeys: readonly string[], refresh: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const refreshRef = useRef(refresh);
  const resourceKeysRef = useRef(resourceKeys);
  useEffect(() => {
    refreshRef.current = refresh;
    resourceKeysRef.current = resourceKeys;
  });
  const key = resourceKeys.join(',');

  useEffect(() => {
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function scheduleRefresh(): void {
      if (coalesceTimer !== null) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        refreshRef.current();
      }, COALESCE_WINDOW_MS);
    }

    function startPolling(): void {
      setStatus('polling');
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
