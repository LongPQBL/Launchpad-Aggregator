import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { WalletProviders } from '@/wallet/providers';
import { themeInitScript } from './theme-init-script';

export const metadata: Metadata = {
  title: 'Launchpad Aggregator',
  description: 'Track Pons launches on Robinhood Chain',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      {/* The shell lives in the layout, not in each page, so the header (wallet connection, search, theme) persists
         across navigations instead of being torn down and rebuilt with every page. */}
      <body><WalletProviders><AppShell>{children}</AppShell></WalletProviders></body>
    </html>
  );
}
