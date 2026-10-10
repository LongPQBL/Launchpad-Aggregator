import { DetailPageSkeleton } from '@/components/detail-page-skeleton';
import type { SkeletonColumn } from '@/components/table-skeleton';

// The launch's Transactions table: static headers are real; the token-symbol column's header depends on the launch, so it stays blank.
const COLUMNS = [
  { label: 'Time', width: 9, bar: 'w-10' },
  { label: 'Type', width: 16, filterIcon: true, bar: 'w-16' },
  { label: '', width: 15, align: 'right', bar: 'w-20' },
  { label: 'For', width: 18, align: 'right', bar: 'w-24' },
  { label: 'USD', width: 13, align: 'right', bar: 'w-12' },
  { label: 'Wallet', width: 14, align: 'right', bar: 'w-20' },
  { label: 'Explorer', width: 15, align: 'right', bar: 'w-20' },
] as const satisfies readonly SkeletonColumn[];

export default function Loading() {
  return <DetailPageSkeleton label="Loading launch" columns={COLUMNS} tabs={['Transactions', 'Pools']} />;
}
