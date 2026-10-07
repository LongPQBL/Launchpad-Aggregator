'use client';

import { useEffect, useRef, useState } from 'react';
import { chainName } from '@/api/chains';
import { launchHref } from '@/api/client';
import { displayName, displaySymbol, formatLifecycleStatus } from '@/api/format';
import { TokenLogo } from './token-logo';

function CopyIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="none" className="shrink-0">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface TokenCellProps {
  chainId: number;
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  lifecycleStatus: string;
}

// The symbol/address swap is driven by the ancestor row's `group` hover (see launch-list.tsx), not
// a hover on this component itself, so the whole row — not just this cell — triggers the slide,
// matching the row-wide background highlight.
export function TokenCell({ chainId, tokenAddress, name, symbol, logoUri, lifecycleStatus }: TokenCellProps) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetRef.current) clearTimeout(resetRef.current);
  }, []);

  async function copyAddress() {
    if (resetRef.current) clearTimeout(resetRef.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(tokenAddress);
      setCopied(true);
      resetRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // No fallback UI here — the row-hover reveal already shows the full-enough short address,
      // and the user can open the launch page to select/copy the full address manually.
    }
  }

  return (
    <div className="flex items-center gap-3">
      <TokenLogo logoUri={logoUri} symbol={displaySymbol(symbol)} chainId={chainId} />
      <div className="flex flex-col">
        <a href={launchHref(chainId, tokenAddress)} className="font-medium text-foreground hover:text-primary hover:underline">
          {displayName(name, tokenAddress)}
        </a>
        <div className="relative h-4 overflow-hidden text-xs leading-4">
          <div className="transition-transform duration-200 ease-out md:group-hover:-translate-y-4">
            <div data-testid="token-symbol" className="text-muted-foreground">{displaySymbol(symbol)}</div>
            <button
              type="button"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyAddress(); }}
              aria-label={copied ? 'Copied' : 'Copy token address'}
              className="flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
            >
              <span>{copied ? 'Copied' : shortAddress(tokenAddress)}</span>
              <CopyIcon />
            </button>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
          <span>{chainName(chainId)}</span> · <span>{formatLifecycleStatus(lifecycleStatus)}</span>
        </span>
      </div>
    </div>
  );
}
