import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PoolDayHistory } from '@/api/client';
import { PoolHistoryChart } from './pool-history-chart';

const DAY = 86_400;
const items: PoolDayHistory[] = [
  { day: 10 * DAY, tradeCount: 3, volumeUsd: '1500', tvlUsd: '40000' },
  { day: 11 * DAY, tradeCount: 0, volumeUsd: '0', tvlUsd: null },
  { day: 12 * DAY, tradeCount: 2, volumeUsd: null, tvlUsd: null },
];

describe('PoolHistoryChart', () => {
  it('draws a bar for a real value, a flat bar for a real zero, and an "unavailable" slot for null', () => {
    render(<PoolHistoryChart items={items} complete />);
    expect(screen.getAllByTestId('history-bar')).toHaveLength(2);
    expect(screen.getAllByTestId('history-bar-unavailable')).toHaveLength(1);
    expect(screen.getByText('Jan 13: unavailable', { exact: false })).toBeInTheDocument();
  });

  it('shows the latest day by default and the hovered day on hover, with a compact USD value', () => {
    render(<PoolHistoryChart items={items} complete />);
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('Unavailable');
    fireEvent.mouseEnter(screen.getAllByTestId('history-bar')[0]!);
    expect(screen.getByTestId('pool-history-readout')).toHaveTextContent('$1.5K');
  });

  it('switches to TVL, and says so when no TVL was recorded', () => {
    render(<PoolHistoryChart items={items.map((day) => ({ ...day, tvlUsd: null }))} complete />);
    fireEvent.click(screen.getByRole('tab', { name: 'TVL' }));
    expect(screen.getByRole('status')).toHaveTextContent('No TVL history recorded');
  });

  it('warns when the pool is still being indexed', () => {
    render(<PoolHistoryChart items={items} complete={false} />);
    expect(screen.getByText(/still being indexed/)).toBeInTheDocument();
  });
});
