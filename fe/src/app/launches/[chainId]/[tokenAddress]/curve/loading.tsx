import { DetailPageSkeleton } from '@/components/detail-page-skeleton';
import type { SkeletonColumn } from '@/components/table-skeleton';

// The curve's Transactions table: same columns as the launch page's, minus the tabs.
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
  return <DetailPageSkeleton label="Loading bonding curve" columns={COLUMNS} heading="Transactions" />;
}
