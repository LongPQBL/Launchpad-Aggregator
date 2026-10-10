import { TableSkeleton, type SkeletonColumn } from '@/components/table-skeleton';

const bar = 'animate-pulse rounded bg-muted';

// What a detail route (launch or pool) shows while its server data loads: the header, the chart and side panel
// blocks, and the transactions table with its real column headers, in the same two-column layout as the page.
export function DetailPageSkeleton({ label, columns, tabs, heading }: {
  label: string; columns: readonly SkeletonColumn[];
  /** Static tab labels, shown for real (the first one active) above the table. */
  tabs?: readonly string[];
  /** A static section heading shown for real above the table. */
  heading?: string;
}) {
  return (
    <article role="status" aria-label={label} className="space-y-4">
      <div aria-hidden="true" className="flex items-center gap-3 px-4 pt-4">
        <span className={`h-12 w-12 shrink-0 rounded-full ${bar}`} />
        <span className="flex flex-col gap-2">
          <span className={`h-6 w-48 ${bar}`} />
          <span className={`h-4 w-64 max-w-full ${bar}`} />
        </span>
      </div>
      <div aria-hidden="true" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-[7.143%]">
        <div className="flex flex-col gap-4">
          <span className={`block h-[360px] w-full rounded-lg ${bar}`} />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className="flex flex-col gap-2">
                <span className={`h-4 w-16 ${bar}`} />
                <span className={`h-6 w-24 ${bar}`} />
              </span>
            ))}
          </div>
        </div>
        <span className={`block h-[420px] w-full rounded-lg ${bar}`} />
      </div>
      {tabs && (
        <div className="flex gap-2">
          {tabs.map((tab, index) => (
            <span key={tab} className={`rounded-md px-3 py-1 text-sm ${index === 0 ?'bg-foreground/10 text-foreground dark:bg-white/10 dark:text-white' :'text-muted-foreground'}`}>{tab}</span>
          ))}
        </div>
      )}
      {heading && <h2 className="text-2xl">{heading}</h2>}
      <TableSkeleton columns={columns} rows={8} label="Loading transactions" cellPadding="edges-only" />
    </article>
  );
}
