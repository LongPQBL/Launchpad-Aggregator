// What a list route shows while its server data loads: a table with the page's real column headers and widths,
// and one placeholder bar per cell that spans its whole column, so nothing shifts when the data arrives.
export interface SkeletonColumn {
  label: string;
  /** Column width in percent of the table, shared with the real table so the two always match. */
  width: number;
  align?: 'left' | 'right';
  /** A round logo placeholder before the bar (token / pool / type columns). */
  logo?: boolean;
}

export function TableSkeleton({ columns, rows = 10, label = 'Loading', rowHeight = 60, headerClassName = 'h-12 text-sm' }: {
  columns: readonly SkeletonColumn[]; rows?: number; label?: string; rowHeight?: number; headerClassName?: string;
}) {
  return (
    <table role="status" aria-label={label} data-testid="table-skeleton" className="w-full table-fixed border-separate border-spacing-0">
      <thead>
        <tr className="bg-card/80 [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          {columns.map((column, index) => (
            <th key={index} style={{ width: `${column.width}%` }}
              className={`px-4 font-medium text-muted-foreground ${headerClassName} ${column.align === 'right' ? 'text-right' : 'text-left'}`}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row} aria-hidden="true" style={{ height: rowHeight }}>
            {columns.map((column, index) => (
              <td key={index} className="px-4">
                <span className="flex items-center gap-3">
                  {column.logo && <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />}
                  <span data-testid="skeleton-cell" className="block h-4 w-full animate-pulse rounded bg-muted" />
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
