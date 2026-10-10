import { DetailPageSkeleton } from '@/components/detail-page-skeleton';
import type { SkeletonColumn } from '@/components/table-skeleton';

// The pool's Transactions table: the two token-amount headers are the pool's own symbols, so they stay blank.
const COLUMNS = [
  { label: 'Time', width: 9, bar: 'w-10' },
  { label: 'Type', width: 16, bar: 'w-16' },
  { label: 'USD', width: 13, align: 'right', bar: 'w-12' },
  { label: '', width: 18, align: 'right', bar: 'w-24' },
  { label: '', width: 18, align: 'right', bar: 'w-24' },
  { label: 'Wallet', width: 13, align: 'right', bar: 'w-20' },
  { label: 'Explorer', width: 13, align: 'right', bar: 'w-20' },
] as const satisfies readonly SkeletonColumn[];

export default function Loading() {
  return <DetailPageSkeleton label="Loading pool" columns={COLUMNS} heading="Transactions" />;
}
