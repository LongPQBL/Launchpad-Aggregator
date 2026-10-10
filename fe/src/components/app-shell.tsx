import type { ReactNode } from 'react';
import Link from 'next/link';
import { WalletControl } from '@/wallet/wallet-control';
import { GlobalSearch } from './global-search';
import { MainNav } from './main-nav';
import { ThemeToggle } from './theme-toggle';
import { StickyAppHeader } from './sticky-app-header';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="app-shell" className="min-h-dvh bg-background text-foreground">
      <StickyAppHeader className="sticky top-0 z-50 border-b border-border bg-card px-4 py-3 sm:px-8 lg:px-[5.3vw]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-5"><span className="text-lg">Launchpad Aggregator</span>
            <MainNav /></div>
          <div className="flex items-center gap-3">
            <GlobalSearch />
            <ThemeToggle />
            <WalletControl />
          </div>
        </div>
      </StickyAppHeader>
      <main className="px-4 py-6 sm:px-8 lg:px-[5.3vw]">{children}</main>
    </div>
  );
}
