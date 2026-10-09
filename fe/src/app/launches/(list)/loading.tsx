import { TableSkeleton } from '@/components/table-skeleton';
import { LAUNCH_COLUMNS } from '@/features/launches/launch-columns';

export default function Loading() {
  return (
    <div className="space-y-4">
      <div aria-hidden="true" className="flex gap-3">
        <span className="h-10 flex-1 animate-pulse rounded-md bg-muted" />
        <span className="h-10 w-40 animate-pulse rounded-md bg-muted" />
      </div>
      <TableSkeleton columns={LAUNCH_COLUMNS} label="Loading launches" rowHeight={76} headerClassName="h-10 text-xs uppercase tracking-wide" />
    </div>
  );
}
