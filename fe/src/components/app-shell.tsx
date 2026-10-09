import type { ReactNode } from 'react';
import Link from 'next/link';
import { WalletControl } from '@/wallet/wallet-control';
import { GlobalSearch } from './global-search';
import { ThemeToggle } from './theme-toggle';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="app-shell" className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-5"><span className="text-lg font-semibold">Launchpad Aggregator</span>
            <nav aria-label="Main navigation" className="flex gap-3 text-sm"><Link href="/">Launches</Link><Link href="/pools">Pools</Link></nav></div>
          <div className="order-last w-full md:order-none md:w-auto md:flex-1 md:px-6"><GlobalSearch /></div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <WalletControl />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
