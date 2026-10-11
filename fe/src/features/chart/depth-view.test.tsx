import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepthView, formatLevel } from './depth-view';

const depth = {
  asks: [1, 2, 3, 4].map((i) => ({ price: 100 + i, amount0: i, total1: i * 100, cumulative1: (i * (i + 1) * 100) / 2 })),
  bids: [1, 2, 3, 4].map((i) => ({ price: 100 - i, amount0: i, total1: i * 100, cumulative1: (i * (i + 1) * 100) / 2 })),
  spreadPercent: 0.1,
};

describe('formatLevel', () => {
  it('uses 3 significant digits below 1 and few decimals above', () => {
    expect(formatLevel(0)).toBe('0');
    expect(formatLevel(0.00000168)).toBe('0.00000168');
    expect(formatLevel(12.3456)).toBe('12.35');
    expect(formatLevel(2540.7)).toBe('2,541');
  });
});

describe('DepthView', () => {
  const view = () => render(<DepthView depth={depth} price={100} baseSymbol="ETH" quoteSymbol="USDC" spreadLabel="Spread 0.1% (Fee tier 0.05%)" notes={['A note.']} />);
  it('lists asks with the farthest on top, the spread row, then bids nearest first, under the right column titles', () => {
    view();
    expect(screen.getByText('Price (USDC)')).toBeInTheDocument();
    expect(screen.getByText('Amount (ETH)')).toBeInTheDocument();
    const asks = screen.getAllByTestId('depth-ask-row').map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    const bids = screen.getAllByTestId('depth-bid-row').map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    expect(asks).toEqual(['104', '103', '102', '101']);
    expect(bids).toEqual(['99', '98', '97', '96']);
    expect(screen.getByTestId('depth-spread')).toHaveTextContent('Spread 0.1% (Fee tier 0.05%)');
    expect(screen.getByText('A note.')).toBeInTheDocument();
  });
  it('zooms the chart in and out and fits it back', () => {
    view();
    const rows = () => [screen.getByTestId('depth-asks').getAttribute('data-rows'), screen.getByTestId('depth-bids').getAttribute('data-rows')];
    expect(rows()).toEqual(['4', '4']);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(rows()).toEqual(['2', '2']);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(rows()).toEqual(['1', '1']);
    fireEvent.click(screen.getByRole('button', { name: 'Fit to chart' }));
    expect(rows()).toEqual(['4', '4']);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(rows()).toEqual(['4', '4']);
  });
  it('says so instead of drawing an empty chart when there is nothing to show', () => {
    render(<DepthView depth={{ asks: [], bids: [], spreadPercent: null }} price={1} baseSymbol="A" quoteSymbol="B" spreadLabel="" />);
    expect(screen.getByRole('status')).toHaveTextContent('No liquidity to show yet.');
  });
});
