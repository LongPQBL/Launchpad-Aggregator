import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
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
      <body><WalletProviders>{children}</WalletProviders></body>
    </html>
  );
}
