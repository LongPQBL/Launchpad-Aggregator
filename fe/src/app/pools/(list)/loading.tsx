import { PageHeading } from '@/components/page-heading';
import { TableSkeleton } from '@/components/table-skeleton';
import { POOL_COLUMNS } from '@/features/pools/pool-columns';

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeading title="Pools" />
      <TableSkeleton columns={POOL_COLUMNS} label="Loading pools" />
    </div>
  );
}
