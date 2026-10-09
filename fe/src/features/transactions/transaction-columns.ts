import type { SkeletonColumn } from '@/components/table-skeleton';

// The global Transactions table's columns in display order, shared by the table and its loading skeleton.
export const TRANSACTION_COLUMNS = [
  { label: 'Time', width: 7 },
  { label: 'Type', width: 31, logo: true },
  { label: 'USD', width: 10, align: 'right' },
  { label: 'Token amount', width: 14, align: 'right' },
  { label: 'Token amount', width: 14, align: 'right' },
  { label: 'Wallet', width: 12, align: 'right' },
  { label: 'Explorer', width: 12, align: 'right' },
] as const satisfies readonly SkeletonColumn[];

export function transactionColumnWidth(index: number): string {
  return `${TRANSACTION_COLUMNS[index]!.width}%`;
}
