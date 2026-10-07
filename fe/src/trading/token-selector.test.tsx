import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenSelector } from './token-selector';

const ethOption = { key: 'eth', symbol: 'ETH', logoUri: null };
const wethOption = { key: 'weth', symbol: 'WETH', logoUri: null };
const fixedOption = { key: '0x1111111111111111111111111111111111111111', symbol: 'LAUNCH', logoUri: null };

describe('TokenSelector', () => {
  it("shows the selected option's symbol on the trigger button", () => {
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /ETH/ })).toBeInTheDocument();
  });

  it('opens a dropdown listing every option when clicked', () => {
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ETH/ }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^ETH$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /WETH/ })).toBeInTheDocument();
  });

  it("calls onSelect with the clicked option's key and closes the dropdown", () => {
    const onSelect = vi.fn();
    render(<TokenSelector options={[ethOption, wethOption]} selected={ethOption} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /ETH/ }));
    fireEvent.click(screen.getByRole('option', { name: /WETH/ }));
    expect(onSelect).toHaveBeenCalledWith('weth');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('still renders the same button-and-dropdown chrome for a single-option list, not a plain label', () => {
    render(<TokenSelector options={[fixedOption]} selected={fixedOption} onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /LAUNCH/ });
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
