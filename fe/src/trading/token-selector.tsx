'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TokenLogo } from '@/features/launches/token-logo';

export interface TokenSelectorOption {
  // Opaque identifier the panel uses to tell options apart — not necessarily an on-chain
  // address by itself (the ETH/WETH pair for a pool's WETH leg share one real address, so
  // 'eth'/'weth' string keys disambiguate them; a pool's other, fixed token uses its own address
  // as its key).
  key: string;
  symbol: string;
  logoUri: string | null;
}

export interface TokenSelectorProps {
  options: readonly TokenSelectorOption[];
  selected: TokenSelectorOption;
  onSelect: (key: string) => void;
  chainId?: number;
  menuPlacement?: 'above' | 'below';
}

// Always renders the same button-and-dropdown chrome regardless of how many options exist —
// including the common case of exactly one (a pool's fixed, non-WETH side) — for visual
// consistency with Uniswap's own "Select a token" pattern. A single-option list is not a dead
// end to special-case away; selecting it is simply a no-op from the caller's perspective.
export function TokenSelector({ options, selected, onSelect, chainId, menuPlacement = 'below' }: TokenSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        className="h-[38px] gap-1 rounded-full bg-black px-2 text-base text-white hover:bg-black hover:text-white"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true"><TokenLogo logoUri={selected.logoUri} symbol={selected.symbol} chainId={chainId} size="swap" /></span>
        <span>{selected.symbol}</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" className="-rotate-90 shrink-0 text-muted-foreground">
          <path d="M15.7071 5.29289C16.0976 5.68342 16.0976 6.31658 15.7071 6.70711L10.4142 12L15.7071 17.2929C16.0976 17.6834 16.0976 18.3166 15.7071 18.7071C15.3166 19.0976 14.6834 19.0976 14.2929 18.7071L8.2929 12.7071C7.9024 12.3166 7.9024 11.6834 8.2929 11.2929L14.2929 5.29289C14.6834 4.90237 15.3166 4.90237 15.7071 5.29289Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
        </svg>
      </Button>
      {open && (
        <ul role="listbox" className={`absolute right-0 z-20 w-48 rounded-md border border-border bg-card p-1.5 text-base shadow-lg ${menuPlacement === 'above' ? 'bottom-full' : 'top-full mt-2'}`}>
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                role="option"
                aria-selected={option.key === selected.key}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-foreground/5"
                onClick={() => { onSelect(option.key); setOpen(false); }}
              >
                <span aria-hidden="true"><TokenLogo logoUri={option.logoUri} symbol={option.symbol} chainId={chainId} /></span>
                {option.symbol}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
