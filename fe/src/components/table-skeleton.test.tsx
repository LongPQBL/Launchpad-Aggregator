import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LAUNCH_COLUMNS } from '@/features/launches/launch-columns';
import { POOL_COLUMNS } from '@/features/pools/pool-columns';
import { TRANSACTION_COLUMNS } from '@/features/transactions/transaction-columns';
import { TableSkeleton } from './table-skeleton';

describe('TableSkeleton', () => {
  it('shows the real column headers at the real widths, with one full-width bar per cell', () => {
    render(<TableSkeleton columns={POOL_COLUMNS} rows={3} label="Loading pools" />);
    const table = screen.getByRole('status', { name: 'Loading pools' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual(POOL_COLUMNS.map((column) => column.label));
    expect(headers.map((header) => header.style.width)).toEqual(POOL_COLUMNS.map((column) => `${column.width}%`));
    const bars = within(table).getAllByTestId('skeleton-cell');
    expect(bars).toHaveLength(3 * POOL_COLUMNS.length);
    expect(bars.every((bar) => bar.classList.contains('w-full'))).toBe(true);
  });

  it('puts a logo placeholder only in the columns that have a logo', () => {
    const { container } = render(<TableSkeleton columns={TRANSACTION_COLUMNS} rows={2} />);
    expect(container.querySelectorAll('tbody .rounded-full')).toHaveLength(2);
  });

  it.each([['pools', POOL_COLUMNS], ['transactions', TRANSACTION_COLUMNS], ['launches', LAUNCH_COLUMNS]] as const)(
    'has %s column widths that add up to exactly 100%%', (_name, columns) => {
      expect(columns.reduce((sum, column) => sum + column.width, 0)).toBe(100);
    });
});
