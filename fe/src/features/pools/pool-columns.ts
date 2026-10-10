import type { SkeletonColumn } from '@/components/table-skeleton';

// The Pools table's columns in display order. The real table and its loading skeleton both read the widths from
// here, so they cannot drift apart.
export const POOL_COLUMNS = [
  { id: 'index', label: '#', width: 5, bar: 'w-4' },
  { id: 'pool', label: 'Pool', width: 29, logo: true, twoLine: true, bar: 'w-36' },
  { id: 'tvl', label: 'TVL', width: 14, align: 'right', bar: 'w-14' },
  { id: 'volume24h', label: '24H Volume', width: 16, align: 'right', bar: 'w-14' },
  { id: 'volume30d', label: '30D Volume', width: 15, align: 'right', bar: 'w-14' },
  { id: 'volumeToTvl', label: '1D Vol/TVL', width: 12, align: 'right', bar: 'w-10' },
  { id: 'age', label: 'Age', width: 9, align: 'right', bar: 'w-8' },
] as const satisfies readonly (SkeletonColumn & { id: string })[];

export type PoolColumnId = (typeof POOL_COLUMNS)[number]['id'];

export function poolColumnWidth(id: PoolColumnId): string {
  return `${POOL_COLUMNS.find((column) => column.id === id)!.width}%`;
}
