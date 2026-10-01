import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { WalletProviders } from '@/wallet/providers';

export const metadata: Metadata = {
  title: 'Launchpad Aggregator',
  description: 'Track Pons launches on Robinhood Chain',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body><WalletProviders>{children}</WalletProviders></body>
    </html>
  );
}
