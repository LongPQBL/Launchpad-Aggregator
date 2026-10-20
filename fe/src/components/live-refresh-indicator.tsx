'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useGatedRefresh } from '@/hooks/use-gated-refresh';
import { emitLaunchChanged, emitPoolChanged, emitTradeCreated } from '@/hooks/live-events';
import { useLiveRefresh } from '@/hooks/use-live-refresh';

export interface LiveRefreshIndicatorProps {
  resourceKeys: readonly string[];
  retryWhilePending?: boolean;
}

export function LiveRefreshIndicator({ resourceKeys, retryWhilePending }: LiveRefreshIndicatorProps) {
  const router = useRouter();
  // A server re-render of a busy token's page can take many seconds on a loaded machine; the 3 s gate alone then started a new one before the last had
  // finished, each slowing the next (five renders of the same page took 49 s each). One refresh at a time: events that arrive meanwhile are folded
  // into a single follow-up once it lands.
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const skipped = useRef(false);
  useEffect(() => { inFlight.current = isPending; }, [isPending]);
  const refresh = useGatedRefresh(() => {
    if (inFlight.current) { skipped.current = true; return; }
    inFlight.current = true;
    startTransition(() => router.refresh());
  });
  useEffect(() => {
    if (!isPending && skipped.current) { skipped.current = false; refresh(); }
  }, [isPending, refresh]);
  // Subscribes for live updates and falls back to periodic refresh; nothing is shown for any connection state.
  useLiveRefresh(resourceKeys, refresh, {
    retryWhilePending,
    onEvent: (type, payload) => {
      if (type === 'trade.created') emitTradeCreated(payload);
      else if (type === 'pool.changed') emitPoolChanged(payload);
      else if (type === 'launch.changed') emitLaunchChanged(payload);
    },
  });
  return null;
}
