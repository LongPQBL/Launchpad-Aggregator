'use client';

import { useRouter } from 'next/navigation';
import { useLiveRefresh } from '@/hooks/use-live-refresh';

const STATUS_LABELS = {
  connecting: 'Connecting to realtime…',
  live: 'Live realtime updates',
  polling: 'Realtime connection lost — refreshing periodically',
};

export interface LiveRefreshIndicatorProps {
  resourceKeys: readonly string[];
}

export function LiveRefreshIndicator({ resourceKeys }: LiveRefreshIndicatorProps) {
  const router = useRouter();
  const status = useLiveRefresh(resourceKeys, () => router.refresh());

  return (
    <p role="status" className="text-xs text-muted-foreground">
      {STATUS_LABELS[status]}
    </p>
  );
}
