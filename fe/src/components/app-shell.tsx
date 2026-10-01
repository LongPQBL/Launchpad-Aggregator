import type { ReactNode } from 'react';
import { WalletControl } from '@/wallet/wallet-control';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="app-shell" className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <span className="text-lg font-semibold">Launchpad Aggregator</span>
          <WalletControl />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
