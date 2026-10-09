'use client';

import { useState } from 'react';
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
}

// Always renders the same button-and-dropdown chrome regardless of how many options exist —
// including the common case of exactly one (a pool's fixed, non-WETH side) — for visual
// consistency with Uniswap's own "Select a token" pattern. A single-option list is not a dead
// end to special-case away; selecting it is simply a no-op from the caller's perspective.
export function TokenSelector({ options, selected, onSelect, chainId }: TokenSelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        className="h-12 gap-2 rounded-full bg-black px-3 text-base text-white hover:bg-black hover:text-white"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TokenLogo logoUri={selected.logoUri} symbol={selected.symbol} chainId={chainId} />
        <span>{selected.symbol}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {open && (
        <ul role="listbox" className="absolute right-0 z-20 mt-2 w-48 rounded-md border border-border bg-card p-1.5 text-base shadow-lg">
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                role="option"
                aria-selected={option.key === selected.key}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-foreground/5"
                onClick={() => { onSelect(option.key); setOpen(false); }}
              >
                <TokenLogo logoUri={option.logoUri} symbol={option.symbol} chainId={chainId} />
                {option.symbol}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
