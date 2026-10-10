import type { SkeletonColumn } from '@/components/table-skeleton';

// The launch list's columns in display order, shared by the table and its loading skeleton.
export const LAUNCH_COLUMNS = [
  { label: '#', width: 4 },
  { label: 'Token', width: 22, logo: true },
  { label: 'Launchpad', width: 12 },
  { label: 'FDV', width: 12, align: 'right' },
  { label: '24H Volume', width: 15, align: 'right' },
  { label: 'Liquidity', width: 12, align: 'right' },
  { label: '1H', width: 8, align: 'right' },
  { label: '1D', width: 8, align: 'right' },
  { label: 'Age', width: 7, align: 'right' },
] as const satisfies readonly SkeletonColumn[];

export function launchColumnWidth(index: number): string {
  return `${LAUNCH_COLUMNS[index]!.width}%`;
}
