'use client';

import { useRouter } from 'next/navigation';
import { useGatedRefresh } from '@/hooks/use-gated-refresh';
import { useLiveRefresh } from '@/hooks/use-live-refresh';

export interface LiveRefreshIndicatorProps {
  resourceKeys: readonly string[];
  retryWhilePending?: boolean;
}

export function LiveRefreshIndicator({ resourceKeys, retryWhilePending }: LiveRefreshIndicatorProps) {
  const router = useRouter();
  const refresh = useGatedRefresh(() => router.refresh());
  // Subscribes for live updates and falls back to periodic refresh; nothing is shown for any connection state.
  useLiveRefresh(resourceKeys, refresh, { retryWhilePending });
  return null;
}
