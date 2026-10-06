import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeSettingsPopover } from './trade-settings-popover';

describe('TradeSettingsPopover', () => {
  it('opens on the gear button and shows the current slippage, with no deadline control for curve venues', () => {
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={vi.fn()} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/deadline/i)).not.toBeInTheDocument();
  });

  it('switches to a custom slippage value and reports it via onChange', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText(/custom slippage/i), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith({ slippageBps: 250, deadlineMinutes: 30 });
  });

  it('shows the deadline control for pool venues, which do take a deadline', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={{ slippageBps: 'auto', deadlineMinutes: 30 }} onChange={onChange} venueKind="pool" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/deadline/i), { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith({ slippageBps: 'auto', deadlineMinutes: 10 });
  });
});
