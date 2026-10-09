'use client';

import { useRouter } from 'next/navigation';
import { useGatedRefresh } from '@/hooks/use-gated-refresh';
import { useLiveRefresh } from '@/hooks/use-live-refresh';

const STATUS_LABELS = {
  connecting: 'Connecting to realtime…',
  live: 'Live realtime updates',
  polling: 'Realtime connection lost — refreshing periodically',
};

export interface LiveRefreshIndicatorProps {
  resourceKeys: readonly string[];
  retryWhilePending?: boolean;
}

export function LiveRefreshIndicator({ resourceKeys, retryWhilePending }: LiveRefreshIndicatorProps) {
  const router = useRouter();
  const refresh = useGatedRefresh(() => router.refresh());
  const status = useLiveRefresh(resourceKeys, refresh, { retryWhilePending });

  if (status === 'live') return null;

  return (
    <p role="status" className="text-xs text-muted-foreground">
      {STATUS_LABELS[status]}
    </p>
  );
}
