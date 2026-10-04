'use client';

import { useState } from 'react';
import { resolveLogoUrl } from '@/api/ipfs';

export interface TokenLogoProps {
  logoUri: string | null;
  symbol: string;
}

// A failed/timed-out IPFS fetch must fall back to the placeholder, never a broken-image icon or an
// infinite spinner — tracked with local state since onError only fires after the browser already
// tried and failed to load the real image.
export function TokenLogo({ logoUri, symbol }: TokenLogoProps) {
  const [failed, setFailed] = useState(false);
  const resolved = resolveLogoUrl(logoUri);

  if (resolved === null || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary"
      >
        {symbol.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- a remote IPFS gateway URL, not a local asset Next's image optimizer can process
    <img
      src={resolved}
      alt="Token logo"
      className="h-8 w-8 rounded-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}
