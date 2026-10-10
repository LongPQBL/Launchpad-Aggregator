import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/pools' }));
vi.mock('@/wallet/wallet-control', () => ({ WalletControl: () => <button>Connect wallet</button> }));

// jsdom has no ResizeObserver (StickyAppHeader observes the header's height).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
describe('AppShell', () => {
  it('shows the app name and a main landmark', () => {
    render(
      <AppShell>
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.getByText('Launchpad Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).not.toHaveClass('dark');
  });

  it('puts the search button immediately before the theme toggle in the header', () => {
    render(<AppShell><p>Content</p></AppShell>);
    const search = screen.getByRole('button', { name: 'Search tokens and pools' });
    const theme = screen.getByRole('button', { name: /Switch to .* theme/ });
    expect(search.parentElement).toBe(theme.parentElement);
    expect(search.nextElementSibling).toBe(theme);
  });

  it('places wallet access in the header without adding trading controls', () => {
    render(
      <AppShell>
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.queryByText(/mua|bán|buy|sell/i)).not.toBeInTheDocument();
  });
});
