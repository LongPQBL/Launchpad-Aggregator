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

  it('puts the unified token and pool search in the header', () => {
    render(<AppShell><p>Content</p></AppShell>);
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('combobox', { name: 'Search tokens and pools' }));
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
