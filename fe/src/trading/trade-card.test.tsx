import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeCard, type TradeCardSide } from './trade-card';

function side(overrides: Partial<TradeCardSide> = {}): TradeCardSide {
  return { value: '', onChange: vi.fn(), ariaLabel: 'Sell amount', selector: <button type="button">TOK</button>, usdText: null, hint: null, ...overrides };
}

describe('TradeCard', () => {
  it('renders Sell and Buy cards with editable inputs and token selectors', () => {
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount', selector: <button type="button">ETH</button> })} onFlip={vi.fn()} />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByLabelText('Sell amount')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Buy amount')).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'TOK' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ETH' })).toBeInTheDocument();
  });

  it('typing in either input reports to that side only', () => {
    const sell = side();
    const buy = side({ ariaLabel: 'Buy amount' });
    render(<TradeCard sell={sell} buy={buy} onFlip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Buy amount'), { target: { value: '3' } });
    expect(buy.onChange).toHaveBeenCalledWith('3');
    expect(sell.onChange).not.toHaveBeenCalled();
  });

  it('shows the $ line only when usdText is set — never a placeholder', () => {
    const { rerender } = render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    rerender(<TradeCard sell={side({ usdText: '$12.34' })} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('shows a hint under the side it belongs to', () => {
    render(<TradeCard sell={side({ hint: 'Quote unavailable' })} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.getByText('Quote unavailable')).toBeInTheDocument();
  });

  it('shows the Min received row only when provided', () => {
    const { rerender } = render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    expect(screen.queryByText(/min received/i)).not.toBeInTheDocument();
    rerender(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} minReceived="27.0063M PROMETHEUS" />);
    expect(screen.getByText(/min received/i)).toBeInTheDocument();
    expect(screen.getByText('27.0063M PROMETHEUS')).toBeInTheDocument();
  });

  it('flip button calls onFlip', () => {
    const onFlip = vi.fn();
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={onFlip} />);
    fireEvent.click(screen.getByRole('button', { name: /flip swap direction/i }));
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('renders the footer below the cards', () => {
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} footer={<button type="button">Swap now</button>} />);
    expect(screen.getByRole('button', { name: 'Swap now' })).toBeInTheDocument();
  });
});
