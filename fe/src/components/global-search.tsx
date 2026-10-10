'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ROADMAP_CHAIN_IDS, chainName } from '@/api/chains';
import { launchHref, poolHref, searchAll, type SearchResults } from '@/api/client';
import { displayName, displaySymbol } from '@/api/format';
import { ChainFilterIcon, ChevronIcon, SelectedCheck, toggleValue } from '@/components/chain-filter';
import { Dialog } from '@/components/ui/dialog';
import { PercentChange } from '@/components/percent-change';
import { TokenImage } from '@/features/launches/token-logo';
import { formatPoolUsd } from '@/features/pools/pool-format';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 250;
type SearchTab = 'all' | 'tokens' | 'pools';
interface Option { key: string; href: string; node: React.ReactNode }

function SearchIcon({ size = 20 }: { size?: number }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.3 4.3" />
  </svg>;
}

function NetworkIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="10" cy="10" r="8" /><path d="M2 10h16M10 2c2.5 2.2 3.8 4.9 3.8 8S12.5 15.8 10 18C7.5 15.8 6.2 13.1 6.2 10S7.5 4.2 10 2Z" />
  </svg>;
}

function SectionIcon({ kind }: { kind: 'tokens' | 'pools' }) {
  return <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[11px]">
    {kind === 'tokens' ? '$' : <span className="flex h-3 w-3 overflow-hidden rounded-full"><span className="w-1/2 bg-current" /><span className="w-1/2 border-l border-current" /></span>}
  </span>;
}

function SearchLogo({ chainId, token0, token1 }: {
  chainId: number; token0: { logoUri: string | null; symbol: string }; token1?: { logoUri: string | null; symbol: string };
}) {
  return <span className="relative h-10 w-10 shrink-0">
    {token1 ? <span className="flex h-10 w-10 overflow-hidden rounded-full">
      <TokenImage logoUri={token0.logoUri ?? null} symbol={token0.symbol} className="h-10 w-5 shrink-0 bg-primary/10" />
      <TokenImage logoUri={token1.logoUri ?? null} symbol={token1.symbol} className="h-10 w-5 shrink-0 border-l border-card bg-primary/20" />
    </span> : <TokenImage logoUri={token0.logoUri ?? null} symbol={token0.symbol} className="h-10 w-10 rounded-full" />}
    <span className="absolute -bottom-1 -right-1 flex h-[19px] w-[19px] items-center justify-center overflow-hidden rounded-full border-2 border-card bg-card">
      <ChainFilterIcon id={chainId} />
    </span>
  </span>;
}

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

function poolCurrencySymbol(address: string, symbol: string | null, launchToken: { address: string; symbol: string | null }): string {
  if (symbol?.trim()) return symbol;
  if (address.toLowerCase() === launchToken.address.toLowerCase() && launchToken.symbol?.trim()) return launchToken.symbol;
  if (address.toLowerCase() === NATIVE_ADDRESS) return 'ETH';
  return '—';
}

function buildOptions(results: SearchResults): { tokens: Option[]; pools: Option[] } {
  return {
    tokens: results.tokens.map((token) => ({
      key: `token:${token.chainId}:${token.tokenAddress}`,
      href: launchHref(token.chainId, token.tokenAddress),
      node: <>
        <SearchLogo chainId={token.chainId} token0={{ logoUri: token.logoUri, symbol: displaySymbol(token.symbol) }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] leading-6">{displayName(token.name, token.tokenAddress)}</span>
          <span className="block truncate text-[14px] text-muted-foreground">{displaySymbol(token.symbol)}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[18px] leading-6">{formatPoolUsd(token.priceUsd ?? null)}</span>
          <span className="flex justify-end text-[14px]"><PercentChange value={token.change1d ?? null} /></span>
        </span>
      </>,
    })),
    pools: results.pools.map((pool) => {
      const symbol0 = poolCurrencySymbol(pool.currency0, pool.currency0Symbol, pool.launchToken);
      const symbol1 = poolCurrencySymbol(pool.currency1, pool.currency1Symbol, pool.launchToken);
      return {
        key: `pool:${pool.chainId}:${pool.protocol}:${pool.poolId}`,
        href: poolHref(pool, pool.launchToken.address),
        node: <>
          <SearchLogo chainId={pool.chainId} token0={{ logoUri: pool.currency0LogoUri, symbol: symbol0 }}
            token1={{ logoUri: pool.currency1LogoUri, symbol: symbol1 }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[18px] leading-6">{symbol0} / {symbol1}</span>
            <span className="block truncate text-[14px] text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {pool.fee / 10_000}%{pool.ponsDesignated && ' · Official Pons pool'}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-[18px] leading-6">{formatPoolUsd(pool.volume24hUsd ?? null)}</span>
            <span className="block text-[14px] text-muted-foreground">24h Vol</span>
          </span>
        </>,
      };
    }),
  };
}

export function GlobalSearch() {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [tab, setTab] = useState<SearchTab>('all');
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);
  const [selectedChains, setSelectedChains] = useState<number[]>([]);
  const [resultState, setResultState] = useState<{ key: string; data: SearchResults } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = text.trim();
  const resultKey = `${query}:${selectedChains.join(',')}`;
  const results = resultState?.key === resultKey ? resultState.data : null;

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open || !query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus('loading');
      searchAll(query, controller.signal, selectedChains.length ? selectedChains : undefined)
        .then((next) => { if (!controller.signal.aborted) { setResultState({ key: resultKey, data: next }); setStatus('idle'); setActiveIndex(-1); } })
        .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query, resultKey, selectedChains]);

  const groups = results ? buildOptions(results) : { tokens: [], pools: [] };
  const tokens = tab === 'pools' ? [] : groups.tokens;
  const pools = tab === 'tokens' ? [] : groups.pools;
  const options = [...tokens, ...pools];

  function close() {
    setOpen(false);
    setNetworkMenuOpen(false);
    setText('');
    setResultState(null);
    setStatus('idle');
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }

  function choose(option: Option) { close(); router.push(option.href); }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActiveIndex((index) => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActiveIndex((index) => index <= 0 ? options.length - 1 : index - 1); }
    else if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); choose(options[activeIndex]!); }
  }

  function renderGroup(label: 'Tokens' | 'Pools', kind: 'tokens' | 'pools', group: Option[], offset: number) {
    if (!group.length) return null;
    return <div role="group" aria-label={label}>
      <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-sm text-muted-foreground"><SectionIcon kind={kind} />{label}</div>
      {group.map((option, index) => <Link key={option.key} id={`${listId}-${offset + index}`} role="option"
        aria-selected={activeIndex === offset + index} href={option.href} onClick={close}
        className={cn('flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted', activeIndex === offset + index && 'bg-muted')}>
        {option.node}
      </Link>)}
    </div>;
  }

  return <>
    <button ref={triggerRef} type="button" aria-label="Search tokens and pools" title="Search tokens and pools"
      onClick={() => setOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-md text-foreground hover:bg-foreground/5">
      <SearchIcon />
    </button>
    <Dialog open={open} onClose={close} title="Search tokens and pools" showHeader={false}
      className="z-[60]" contentClassName="max-w-[680px] p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SearchIcon size={21} />
        <input ref={inputRef} type="search" role="combobox" aria-label="Search tokens and pools"
          aria-expanded={!!query} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          placeholder="Search tokens and pools" value={text}
          onChange={(event) => { setText(event.target.value); setActiveIndex(-1); setStatus('idle'); }}
          onKeyDown={onKeyDown} className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
        <div className="relative shrink-0">
          <button type="button" aria-label="Filter by network" aria-expanded={networkMenuOpen}
            onClick={() => setNetworkMenuOpen((value) => !value)}
            className="flex h-9 items-center gap-1.5 rounded-full border border-border px-2.5 text-muted-foreground hover:text-foreground">
            {selectedChains.length === 1 ? <ChainFilterIcon id={selectedChains[0]!} /> : <NetworkIcon />}
            <ChevronIcon />
          </button>
          {networkMenuOpen && <div className="absolute right-0 top-full z-20 mt-2 max-h-[min(60vh,360px)] w-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl">
            <button type="button" aria-pressed={!selectedChains.length} onClick={() => { setSelectedChains([]); setNetworkMenuOpen(false); setActiveIndex(-1); }}
              className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
              <span className="flex items-center gap-2"><NetworkIcon />All networks</span>
              {!selectedChains.length && <SelectedCheck />}
            </button>
            {ROADMAP_CHAIN_IDS.map((id) => <button key={id} type="button" aria-pressed={selectedChains.includes(id)}
              onClick={() => { setSelectedChains((current) => toggleValue(current, id)); setNetworkMenuOpen(false); setActiveIndex(-1); }}
              className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
              <span className="flex items-center gap-2"><ChainFilterIcon id={id} />{chainName(id)}</span>
              {selectedChains.includes(id) && <SelectedCheck />}
            </button>)}
          </div>}
        </div>
      </div>
      <div role="tablist" aria-label="Search result type" className="flex gap-5 border-b border-border px-4 pt-3">
        {(['all', 'tokens', 'pools'] as const).map((value) => <button key={value} type="button" role="tab"
          aria-selected={tab === value} onClick={() => { setTab(value); setActiveIndex(-1); }}
          className={cn('border-b-2 pb-2 text-sm transition-colors', tab === value
            ? 'border-foreground text-foreground dark:border-white dark:text-white'
            : 'border-transparent text-foreground/50 hover:text-foreground dark:text-white/50 dark:hover:text-white')}>
          {value === 'all' ? 'All' : value === 'tokens' ? 'Tokens' : 'Pools'}
        </button>)}
      </div>
      <div id={listId} role="listbox" aria-label="Search results" className="max-h-[min(60vh,520px)] overflow-y-auto p-2">
        {query && renderGroup('Tokens', 'tokens', tokens, 0)}
        {query && renderGroup('Pools', 'pools', pools, tokens.length)}
        {!query && <p className="px-3 py-5 text-sm text-muted-foreground">Search tokens and pools</p>}
        {query && !results && status !== 'error' && <p role="status" className="px-3 py-5 text-sm text-muted-foreground">Searching…</p>}
        {query && status === 'error' && <p role="alert" className="px-3 py-5 text-sm text-muted-foreground">Search is unavailable right now.</p>}
        {query && results && options.length === 0 && <p className="px-3 py-5 text-sm text-muted-foreground">No results for “{query}”.</p>}
      </div>
    </Dialog>
  </>;
}
