'use client';

import { useRouter } from 'next/navigation';
import { useLiveRefresh } from '@/hooks/use-live-refresh';

const STATUS_LABELS = {
  connecting: 'Đang kết nối realtime…',
  live: 'Đang cập nhật realtime',
  polling: 'Mất kết nối realtime — đang làm mới định kỳ',
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
