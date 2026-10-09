import type { SkeletonColumn } from '@/components/table-skeleton';

// The Pools table's columns in display order. The real table and its loading skeleton both read the widths from
// here, so they cannot drift apart.
export const POOL_COLUMNS = [
  { id: 'index', label: '#', width: 5 },
  { id: 'pool', label: 'Pool', width: 29, logo: true },
  { id: 'tvl', label: 'TVL', width: 14, align: 'right' },
  { id: 'volume24h', label: '24H volume', width: 16, align: 'right' },
  { id: 'volume30d', label: '30D volume', width: 15, align: 'right' },
  { id: 'volumeToTvl', label: '1D Vol/TVL', width: 12, align: 'right' },
  { id: 'age', label: 'Age', width: 9, align: 'right' },
] as const satisfies readonly (SkeletonColumn & { id: string })[];

export type PoolColumnId = (typeof POOL_COLUMNS)[number]['id'];

export function poolColumnWidth(id: PoolColumnId): string {
  return `${POOL_COLUMNS.find((column) => column.id === id)!.width}%`;
}
