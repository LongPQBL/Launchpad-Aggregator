import type { ReactNode } from 'react';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="app-shell" className="dark min-h-dvh bg-background text-foreground">
      <header className="border-b border-border px-4 py-3">
        <span className="text-lg font-semibold">Launchpad Aggregator</span>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <footer data-testid="chart-attribution" className="px-4 py-3 text-xs text-muted-foreground" />
    </div>
  );
}
