'use client';

import { useEffect, useRef, useState } from 'react';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function CopyableTokenAddress({ address, label = 'Token address', copyLabel, showCopyIcon = false }: { address: string; label?: string; copyLabel?: string; showCopyIcon?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  async function copyAddress() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(address);
      setCopied(true);
      resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Keep the address visible if the clipboard is unavailable.
    }
  }

  return (
    <div role="group" aria-label={label} className="group/address inline-flex min-w-0 max-w-full items-center gap-1.5">
      <button type="button" data-testid="header-token-address" onClick={() => void copyAddress()}
        className="min-w-0 truncate cursor-pointer text-sm text-muted-foreground">
        {shortAddress(address)}
      </button>
      <button
        type="button"
        onClick={() => void copyAddress()}
        aria-label={copied ? 'Copied' : copyLabel ?? `Copy ${label.toLowerCase()}`}
        className={copied
          ? 'inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-success p-0 text-success-foreground hover:bg-success/90'
          : showCopyIcon
            ? 'inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
            : 'pointer-events-none inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full p-0 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/address:pointer-events-auto group-hover/address:opacity-100 group-focus-within/address:pointer-events-auto group-focus-within/address:opacity-100'}
      >
        {copied ? (
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
            <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}
