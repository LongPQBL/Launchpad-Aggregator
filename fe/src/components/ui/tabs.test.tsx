import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs } from './tabs';

describe('Tabs', () => {
  it('shows the first tab\'s content by default and switches content on click, without unmounting the tablist', () => {
    render(<Tabs tabs={[
      { value: 'transactions', label: 'Transactions', content: <p>Transaction rows</p> },
      { value: 'pools', label: 'Pools', content: <p>Pool rows</p> },
    ]} />);
    expect(screen.getByText('Transaction rows')).toBeInTheDocument();
    expect(screen.queryByText('Pool rows')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Pools' }));
    expect(screen.getByText('Pool rows')).toBeInTheDocument();
    expect(screen.queryByText('Transaction rows')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pools' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute('aria-selected', 'false');
  });

  it('honors an explicit defaultValue', () => {
    render(<Tabs defaultValue="pools" tabs={[
      { value: 'transactions', label: 'Transactions', content: <p>Transaction rows</p> },
      { value: 'pools', label: 'Pools', content: <p>Pool rows</p> },
    ]} />);
    expect(screen.getByText('Pool rows')).toBeInTheDocument();
  });
});
