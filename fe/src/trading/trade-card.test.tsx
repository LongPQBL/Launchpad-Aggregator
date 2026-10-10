import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeCard, type TradeCardSide } from './trade-card';
import { textContent } from '../test-utils/text-content';

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

  it('moves the dark background to the input the user focuses', () => {
    render(<TradeCard sell={side()} buy={side({ ariaLabel: 'Buy amount' })} onFlip={vi.fn()} />);
    const sellCard = screen.getByLabelText('Sell amount').closest('.isolate');
    const buyInput = screen.getByLabelText('Buy amount');
    const buyCard = buyInput.closest('.isolate');
    expect(sellCard).toHaveClass('isolate');
    expect(sellCard?.querySelector('[aria-hidden="true"]')).toHaveClass('bg-black');
    expect(buyCard).toHaveClass('isolate');
    expect(buyCard?.querySelector('[aria-hidden="true"]')).toHaveClass('absolute', '-z-10', 'bg-[#1b1d23]/70');
    expect(buyCard?.querySelector('.relative')).toContainElement(buyInput);

    fireEvent.focus(buyInput);
    expect(buyCard?.querySelector('[aria-hidden="true"]')).toHaveClass('bg-black');
    expect(sellCard?.querySelector('[aria-hidden="true"]')).toHaveClass('bg-[#1b1d23]/70');
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

  it('shows the Sell balance under its token selector and turns the amount and balance red when insufficient', () => {
    const buy = side({ ariaLabel: 'Buy amount', selector: <button type="button">ETH</button> });
    const { rerender } = render(<TradeCard sell={side({ balanceText: 'Balance: 2 TOK', insufficientBalance: true })} buy={buy} onFlip={vi.fn()} />);
    const balance = screen.getByText(textContent('Balance: 2 TOK'));
    expect(balance).toHaveClass('text-destructive');
    expect(balance.parentElement).toContainElement(screen.getByRole('button', { name: 'TOK' }));
    expect(screen.getByLabelText('Sell amount')).toHaveClass('text-destructive');
    expect(screen.getByLabelText('Buy amount')).not.toHaveClass('text-destructive');
    rerender(<TradeCard sell={side({ balanceText: 'Balance: 2 TOK', insufficientBalance: false })} buy={buy} onFlip={vi.fn()} />);
    expect(screen.getByText(textContent('Balance: 2 TOK'))).not.toHaveClass('text-destructive');
    expect(screen.getByLabelText('Sell amount')).not.toHaveClass('text-destructive');
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
