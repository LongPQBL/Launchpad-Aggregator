import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeSettingsPopover } from './trade-settings-popover';

const baseSettings = { slippageBps: 'auto' as const, deadlineMinutes: 30, oneClickTradeOptIn: false };

describe('TradeSettingsPopover', () => {
  it('uses the supplied settings icon and shows feature descriptions in circular info tooltips', () => {
    const { container } = render(<TradeSettingsPopover settings={baseSettings} onChange={vi.fn()} venueKind="pool" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));

    expect(screen.getByRole('button', { name: /settings/i }).querySelector('img'))
      .toHaveAttribute('src', '/images/trading/settings.png');
    expect(screen.getByRole('tooltip', { name: 'Max slippage' })).toHaveTextContent(/price movement/i);
    expect(screen.getByRole('tooltip', { name: 'Custom slippage %' })).toHaveTextContent(/trade fails/i);
    expect(screen.getByRole('tooltip', { name: 'Swap deadline (minutes)' })).toHaveTextContent(/transaction.*confirmed/i);
    expect(screen.getByRole('tooltip', { name: '1-click trade' })).toHaveTextContent(/one confirmation/i);
    expect(container.querySelectorAll('[aria-label^="About "]')).toHaveLength(4);
  });

  it('opens on the gear button and shows the current slippage, with no deadline control for curve venues', () => {
    render(<TradeSettingsPopover settings={baseSettings} onChange={vi.fn()} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Deadline minutes')).not.toBeInTheDocument();
  });

  it('switches to a custom slippage value and reports it via onChange', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={baseSettings} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText('Custom slippage'), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith({ ...baseSettings, slippageBps: 250 });
  });

  it('rejects a custom slippage value above 50%, never reporting an out-of-range value via onChange', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={baseSettings} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText('Custom slippage'), { target: { value: '150' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the deadline control for pool venues, which do take a deadline', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={baseSettings} onChange={onChange} venueKind="pool" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Deadline minutes'), { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith({ ...baseSettings, deadlineMinutes: 10 });
  });

  it('shows the 1-click trade toggle as off by default, for both curve and pool venues', () => {
    render(<TradeSettingsPopover settings={baseSettings} onChange={vi.fn()} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: '1-click trade' })).toHaveTextContent(/off/i);
  });

  it('toggles 1-click trade on and reports it via onChange, leaving other settings untouched', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={baseSettings} onChange={onChange} venueKind="pool" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    fireEvent.click(screen.getByRole('button', { name: '1-click trade' }));
    expect(onChange).toHaveBeenCalledWith({ ...baseSettings, oneClickTradeOptIn: true });
  });

  it('toggles 1-click trade back off when it is already on', () => {
    const onChange = vi.fn();
    render(<TradeSettingsPopover settings={{ ...baseSettings, oneClickTradeOptIn: true }} onChange={onChange} venueKind="curve" />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('button', { name: '1-click trade' })).toHaveTextContent(/on/i);
    fireEvent.click(screen.getByRole('button', { name: '1-click trade' }));
    expect(onChange).toHaveBeenCalledWith({ ...baseSettings, oneClickTradeOptIn: false });
  });
});
