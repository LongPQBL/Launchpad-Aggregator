import { useEffect, useState } from 'react';

const TICK_INTERVAL_MS = 1_000;

// Ticks forward once a second so a "10s" label becomes "11s" without a data refresh.
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function formatRelativeTime(timestampSeconds: number, nowMs: number): string {
  const diffSeconds = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diffSeconds / 3600);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(diffSeconds / 86_400)}d`;
}
