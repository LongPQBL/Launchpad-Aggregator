import { PageHeading } from '@/components/page-heading';

// What a route shows while its server data is loading: the heading row and a table-shaped skeleton with the same
// heights as the real table (48px header, 60px rows), so the page does not jump when the data arrives.
export function PageSkeleton({ title, rows = 10 }: { title?: string; rows?: number }) {
  return (
    <div className="space-y-4" role="status" aria-label="Loading" data-testid="page-skeleton">
      <PageHeading title={title ?? ''} />
      <div className="h-12 rounded-lg bg-card/80" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-[60px] items-center gap-4 px-4" aria-hidden="true">
          <span className="h-4 w-8 animate-pulse rounded bg-muted" />
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="h-4 w-40 animate-pulse rounded bg-muted" />
          <span className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
          <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          <span className="h-4 w-20 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
