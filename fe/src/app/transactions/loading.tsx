import { PageHeading } from '@/components/page-heading';
import { TableSkeleton } from '@/components/table-skeleton';
import { TRANSACTION_COLUMNS } from '@/features/transactions/transaction-columns';

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeading title="Transactions" />
      <TableSkeleton columns={TRANSACTION_COLUMNS} label="Loading transactions" />
    </div>
  );
}
