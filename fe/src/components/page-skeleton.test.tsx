import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageSkeleton } from './page-skeleton';

describe('PageSkeleton', () => {
  it('shows the page title (when it has one) and a loading status with placeholder rows', () => {
    render(<PageSkeleton title="Pools" rows={4} />);
    expect(screen.getByRole('heading', { name: 'Pools' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByTestId('page-skeleton').querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('renders no empty heading when there is no title', () => {
    render(<PageSkeleton />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
