'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { launchHref, poolHref, searchAll, type SearchResults } from '@/api/client';
import { displayName, displaySymbol } from '@/api/format';
import { TokenLogo } from '@/features/launches/token-logo';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

interface Option { key: string; href: string; node: React.ReactNode }

function buildOptions(results: SearchResults): { tokens: Option[]; pools: Option[] } {
  return {
    tokens: results.tokens.map((token) => ({
      key: `token:${token.chainId}:${token.tokenAddress}`,
      href: launchHref(token.chainId, token.tokenAddress),
      node: (
        <>
          <TokenLogo logoUri={token.logoUri} symbol={displaySymbol(token.symbol)} chainId={token.chainId} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{displayName(token.name, token.tokenAddress)}</span>
            <span className="block text-xs text-muted-foreground">{displaySymbol(token.symbol)} · {token.platform}</span>
          </span>
        </>
      ),
    })),
    pools: results.pools.map((pool) => ({
      key: `pool:${pool.chainId}:${pool.protocol}:${pool.poolId}`,
      href: poolHref(pool, pool.launchToken.address),
      node: (
        <>
          <TokenLogo logoUri={pool.launchToken.logoUri} symbol={displaySymbol(pool.launchToken.symbol)} chainId={pool.chainId} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{displaySymbol(pool.launchToken.symbol)} pool</span>
            <span className="block text-xs text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {pool.fee / 10_000}%</span>
          </span>
        </>
      ),
    })),
  };
}

// One box for tokens and pools, as in Uniswap's header search. Debounced, cancels the previous request
// when the text changes, and supports arrow-key navigation (the options are real links as well).
export function GlobalSearch() {
  const router = useRouter();
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const query = text.trim();
  const searchable = query.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus('loading');
      searchAll(query, controller.signal)
        .then((next) => { setResults(next); setStatus('idle'); setActiveIndex(-1); })
        .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, searchable]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!containerRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const visibleResults = searchable ? results : null;
  const { tokens, pools } = visibleResults ? buildOptions(visibleResults) : { tokens: [], pools: [] };
  const options = [...tokens, ...pools];
  const showPanel = open && searchable;

  function choose(option: Option): void {
    setOpen(false);
    setText('');
    router.push(option.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((index) => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => (index <= 0 ? options.length - 1 : index - 1)); }
    else if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); choose(options[activeIndex]!); }
  }

  function renderGroup(label: string, group: Option[], offset: number) {
    if (group.length === 0) return null;
    return (
      <div role="group" aria-label={label}>
        <p className="px-3 pb-1 pt-2 text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        {group.map((option, index) => {
          const active = offset + index === activeIndex;
          return (
            <Link key={option.key} id={`${listId}-${offset + index}`} role="option" aria-selected={active} href={option.href}
              onClick={() => { setOpen(false); setText(''); }}
              className={cn('flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted', active && 'bg-muted')}>
              {option.node}
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <input
        type="search"
        role="combobox"
        aria-label="Search tokens and pools"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        placeholder="Search tokens and pools"
        value={text}
        onChange={(event) => { setText(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-full border border-input bg-transparent px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {showPanel && (
        <div id={listId} role="listbox" aria-label="Search results"
          className="absolute left-0 right-0 z-30 mt-2 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-md">
          {renderGroup('Tokens', tokens, 0)}
          {renderGroup('Pools', pools, tokens.length)}
          {status === 'loading' && options.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">Searching…</p>}
          {status === 'error' && <p role="alert" className="px-3 py-3 text-sm text-muted-foreground">Search is unavailable right now.</p>}
          {status === 'idle' && visibleResults && options.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No results for “{query}”.</p>}
        </div>
      )}
    </div>
  );
}
