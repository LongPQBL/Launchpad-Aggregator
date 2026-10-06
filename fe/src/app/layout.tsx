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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body><WalletProviders>{children}</WalletProviders></body>
    </html>
  );
}
