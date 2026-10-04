'use client';

import Image from 'next/image';
import { useState } from 'react';
import { resolveLogoUrl } from '@/api/ipfs';

export interface TokenLogoProps {
  logoUri: string | null;
  symbol: string;
  chainId?: number;
}

// A failed/timed-out IPFS fetch must fall back to the placeholder, never a broken-image icon or an
// infinite spinner — tracked with local state since onError only fires after the browser already
// tried and failed to load the real image.
export function TokenLogo({ logoUri, symbol, chainId }: TokenLogoProps) {
  const [failed, setFailed] = useState(false);
  const resolved = resolveLogoUrl(logoUri);

  return (
    <span className="relative inline-flex h-8 w-8 shrink-0">
      {resolved === null || failed ? (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary"
        >
          {symbol.charAt(0).toUpperCase()}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a remote IPFS gateway URL, not a local asset Next's image optimizer can process
        <img
          src={resolved}
          alt="Token logo"
          className="h-8 w-8 rounded-full object-cover"
          onError={() => setFailed(true)}
          // The server-rendered <img> can start loading from the raw HTML stream before React
          // hydrates and attaches onError; if it already failed by then, the native error event
          // fired too early for onError to ever catch it. This ref callback runs at mount/commit
          // time and checks for that already-settled failure directly (final-review Important 4).
          ref={(node) => {
            if (node && node.complete && node.naturalWidth === 0) setFailed(true);
          }}
        />
      )}
      {chainId === 4663 && (
        <Image
          src="/images/chains/robinhood-chain.png"
          alt="Robinhood Chain"
          width={16}
          height={16}
          unoptimized
          className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card bg-card"
        />
      )}
    </span>
  );
}
