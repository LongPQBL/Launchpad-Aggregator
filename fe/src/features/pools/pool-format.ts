import { formatUsd } from '@/api/format';

// Pure formatting helpers shared between the client-only PoolList (pool-list.tsx, 'use client')
// and the server-rendered PoolDetail (pool-detail.tsx) — kept out of pool-list.tsx because a
// Server Component may only import plain functions from a non-'use client' module; importing
// them from a 'use client' file throws at render time ("Attempted to call X from the server but
// X is on the client").
export function short(address: string): string {
  return address === '0x0000000000000000000000000000000000000000' ? 'ETH' : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// A pool younger than 24h has no previous 24h window to compare its volume against.
export function isYoungerThan24h(timestamp: number | null): boolean {
  return timestamp !== null && Math.floor(Date.now() / 1000) - timestamp < 86400;
}

export function poolAge(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2,
});
function trimFractionZeros(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
export function formatPoolUsd(value: string | null): string {
  if (value === null) return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.abs(numeric) >= 1_000
    ? compactUsd.format(numeric)
    : trimFractionZeros(formatUsd(value, 2));
}
