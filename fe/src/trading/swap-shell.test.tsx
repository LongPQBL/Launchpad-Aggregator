import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SwapShell } from './swap-shell';

const settings = { slippageBps: 'auto' as const, deadlineMinutes: 30, oneClickTradeOptIn: false };

describe('SwapShell', () => {
  it('shows the Swap pill, the venue badge, the settings gear and its children', () => {
    render(<SwapShell venueLabel="Bonding curve" settings={settings} onSettingsChange={vi.fn()} venueKind="curve"><p>body</p></SwapShell>);
    expect(screen.getByText('Swap')).toBeInTheDocument();
    expect(screen.getByText('Bonding curve')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows no Limit/Buy/Sell tabs', () => {
    render(<SwapShell venueLabel="Uniswap V4 pool" settings={settings} onSettingsChange={vi.fn()} venueKind="pool"><p>x</p></SwapShell>);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Limit')).not.toBeInTheDocument();
  });
});
