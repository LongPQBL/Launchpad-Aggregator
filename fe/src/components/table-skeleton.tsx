import { UpDownIcon } from '@/components/up-down-icon';

// What a list route shows while its server data loads: a table with the page's real column headers and widths,
// and one placeholder bar per cell that spans its whole column, so nothing shifts when the data arrives.
export interface SkeletonColumn {
  label: string;
  /** Column width in percent of the table, shared with the real table so the two always match. */
  width: number;
  align?: 'left' | 'right';
  /** A round logo placeholder before the bar (token / pool / type columns). */
  logo?: boolean;
  /** Width class of the placeholder bar, sized like the real value (default w-16). */
  bar?: string;
  /** Two stacked lines (name over detail) instead of one. */
  twoLine?: boolean;
  /** The header carries the type-filter's up/down icon, so the skeleton header reserves the same width. */
  filterIcon?: boolean;
}

export function TableSkeleton({ columns, rows = 10, label = 'Loading', rowHeight = 60, headerClassName = 'h-10 text-sm', cellPadding = 'px-4' }: {
  columns: readonly SkeletonColumn[]; rows?: number; label?: string; rowHeight?: number; headerClassName?: string;
  /** 'edges-only' matches tables whose cells use px-2 with a wider left/right edge (the Transactions table). */
  cellPadding?: 'px-4' | 'edges-only';
}) {
  return (
    <table role="status" aria-label={label} data-testid="table-skeleton" className="w-full table-fixed border-separate border-spacing-0">
      <thead>
        <tr className="[&>th]:bg-muted [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
          {columns.map((column, index) => (
            <th key={index} style={{ width: `${column.width}%` }}
              className={`${padding(index, columns.length, cellPadding)} text-muted-foreground ${headerClassName} ${column.align === 'right' ? 'text-right' : 'text-left'}`}>
              {column.filterIcon ? <span className="inline-flex items-center gap-1.5"><UpDownIcon />{column.label}</span> : column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row} aria-hidden="true" style={{ height: rowHeight }}>
            {columns.map((column, index) => (
              <td key={index} className={padding(index, columns.length, cellPadding)}>
                <span className={`flex items-center gap-3 ${column.align === 'right' ? 'justify-end' : ''}`}>
                  {column.logo && <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />}
                  {column.twoLine ? (
                    <span className="flex flex-col gap-1.5">
                      <span data-testid="skeleton-cell" className={`block h-4 max-w-full animate-pulse rounded bg-muted ${column.bar ?? 'w-16'}`} />
                      <span className="block h-3 w-20 max-w-full animate-pulse rounded bg-muted" />
                    </span>
                  ) : (
                    <span data-testid="skeleton-cell" className={`block h-4 max-w-full animate-pulse rounded bg-muted ${column.bar ?? 'w-16'}`} />
                  )}
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function padding(index: number, count: number, mode: 'px-4' | 'edges-only'): string {
  if (mode === 'px-4') return 'px-4';
  return `px-2 ${index === 0 ? 'pl-4' : ''} ${index === count - 1 ? 'pr-4' : ''}`;
}
