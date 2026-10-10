import type { SkeletonColumn } from '@/components/table-skeleton';

// The global Transactions table's columns in display order, shared by the table and its loading skeleton.
export const TRANSACTION_COLUMNS = [
  { label: 'Time', width: 7, bar: 'w-10' },
  { label: 'Type', width: 31, filterIcon: true, bar: 'w-64' },
  { label: 'USD', width: 10, align: 'right', bar: 'w-12' },
  { label: 'Token Amount', width: 14, align: 'right', bar: 'w-24' },
  { label: 'Token Amount', width: 14, align: 'right', bar: 'w-24' },
  { label: 'Wallet', width: 12, align: 'right', bar: 'w-20' },
  { label: 'Explorer', width: 12, align: 'right', bar: 'w-20' },
] as const satisfies readonly SkeletonColumn[];

export function transactionColumnWidth(index: number): string {
  return `${TRANSACTION_COLUMNS[index]!.width}%`;
}
