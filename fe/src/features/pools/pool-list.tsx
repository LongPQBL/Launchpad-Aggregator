'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLaunchPools, getPools, poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PercentChange } from '@/components/percent-change';
import { PoolLogo, type PoolLogoToken } from './pool-logo';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { cn } from '@/lib/utils';
import { formatPoolUsd, poolAge, short } from './pool-format';

function side(address: string): string { return address.toLowerCase(); }

export interface PoolListDisplayedToken { address: string; symbol: string; logoUri: string | null }
export type PrimaryLaunchVenue =
  | { kind: 'curve'; token: PoolListDisplayedToken; quoteSymbol: string; chainId: number }
  | { kind: 'pool'; pool: PoolSummary | null; poolId: string; protocol: string };

type PoolSort = 'fdvUsd' | 'volume24hUsd' | 'tvlUsd' | 'change1h' | 'change1d' | 'age';
const POOL_SORT_COLUMNS: { label: string; sort: PoolSort; defaultDirection: 'asc' | 'desc'; width: string }[] = [
  { label: 'FDV', sort: 'fdvUsd', defaultDirection: 'desc', width: 'md:w-[13%]' },
  { label: '24H volume', sort: 'volume24hUsd', defaultDirection: 'desc', width: 'md:w-[15%]' },
  { label: 'Liquidity', sort: 'tvlUsd', defaultDirection: 'desc', width: 'md:w-[13%]' },
  { label: '1H', sort: 'change1h', defaultDirection: 'desc', width: 'md:w-[9%]' },
  { label: '1D', sort: 'change1d', defaultDirection: 'desc', width: 'md:w-[9%]' },
  { label: 'Age', sort: 'age', defaultDirection: 'asc', width: 'md:w-[9%]' },
];

function poolSortValue(pool: PoolSummary, sort: PoolSort): number | null {
  if (sort === 'age') return pool.createdTimestamp === null ? null : -pool.createdTimestamp;
  const value = pool[sort];
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// currencyXSymbol/currencyXLogoUri come from the backend's token-metadata resolver (RPC name/
// symbol + Robinhood asset-directory logo for non-Pons tokens); when one side is the launch token
// whose page this list is embedded in, prefer the caller's own already-known metadata over a fresh
// resolver round trip for the exact same address.
function poolLogoToken(pool: PoolSummary, address: string, apiSymbol: string | null, apiLogoUri: string | null,
  displayedToken?: PoolListDisplayedToken): PoolLogoToken {
  if (displayedToken && side(address) === side(displayedToken.address)) {
    return { symbol: displayedToken.symbol, logoUri: displayedToken.logoUri };
  }
  return { symbol: apiSymbol ?? short(address), logoUri: apiLogoUri };
}
function pairLabel(pool: PoolSummary, displayedToken?: PoolListDisplayedToken): string {
  const label = (address: string, symbol: string | null) =>
    displayedToken && side(address) === side(displayedToken.address) ? displayedToken.symbol : (symbol ?? short(address));
  return `${label(pool.currency0, pool.currency0Symbol)} / ${label(pool.currency1, pool.currency1Symbol)}`;
}
// Mirrors LaunchRowsSkeleton in launches/launch-list.tsx: pulsing placeholder rows in the table's own layout.
const POOL_SKELETON_NUMERIC_WIDTHS = ['w-14', 'w-16', 'w-14', 'w-10', 'w-10', 'w-8'] as const;

function PoolRowsSkeleton({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div key={index} role="row" aria-hidden="true" data-testid="pool-skeleton-row" className="rounded-lg p-3 md:table-row md:rounded-none md:p-0">
      <div role="cell" className="md:table-cell md:p-4 md:align-middle"><span className="block h-4 w-4 animate-pulse rounded bg-muted" /></div>
      <div role="cell" className="md:table-cell md:p-4 md:align-middle">
        <span className="flex items-center gap-3">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="grid gap-1.5"><span className="h-3 w-28 animate-pulse rounded bg-muted" /><span className="h-2.5 w-16 animate-pulse rounded bg-muted" /></span>
        </span>
      </div>
      {POOL_SKELETON_NUMERIC_WIDTHS.map((width, cell) => (
        <div key={cell} role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
          <span className={cn('ml-auto block h-4 animate-pulse rounded bg-muted', width)} />
        </div>
      ))}
    </div>
  ));
}

export function PoolList({ page, error = false, tokenAddress, chainId, displayedToken, primaryVenue }: {
  page: PoolPage | null; error?: boolean; tokenAddress?: string; chainId?: number;
  displayedToken?: PoolListDisplayedToken;
  primaryVenue?: PrimaryLaunchVenue | null;
}) {
  const [items, setItems] = useState<readonly PoolSummary[]>(page?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(page?.nextCursor ?? null);
  const [sortBy, setSortBy] = useState<PoolSort | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const sortedItems = useMemo(() => {
    if (sortBy === null) return items;
    return [...items].sort((a, b) => {
      const left = poolSortValue(a, sortBy);
      const right = poolSortValue(b, sortBy);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      const comparison = left - right;
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [items, sortBy, sortDirection]);

  // Merge the server-provided first page when it changes, keeping pages the user already loaded
  // (React's "adjust state during render" pattern).
  const [syncedPage, setSyncedPage] = useState(page);
  if (syncedPage !== page) {
    setSyncedPage(page);
    const merged = mergeRefreshedPage(page?.items ?? [], page?.nextCursor ?? null, items, nextCursor,
      (pool) => `${pool.chainId}:${pool.protocol}:${pool.poolId}`);
    setItems(merged.items);
    setNextCursor(merged.nextCursor);
    setLoadError(false);
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current || (tokenAddress && chainId === undefined)) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = tokenAddress
        ? await getLaunchPools(chainId!, tokenAddress, { cursor: nextCursor, excludeOfficial: true })
        : await getPools({ cursor: nextCursor, chainId });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [chainId, nextCursor, tokenAddress]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadError, loadMore, nextCursor]);

  return <section aria-label={tokenAddress ? 'Other pools for this token' : 'Pools'} className="space-y-4">
    {primaryVenue && <section aria-label="Pons primary venue"><Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-4">
        {primaryVenue.kind === 'curve' ? <>
          <PoolLogo token0={{ symbol: primaryVenue.token.symbol, logoUri: primaryVenue.token.logoUri }}
            token1={{ symbol: primaryVenue.quoteSymbol, logoUri: null }} chainId={primaryVenue.chainId} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{primaryVenue.token.symbol} / {primaryVenue.quoteSymbol}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">Pons bonding curve</Badge>
              <span className="text-xs text-muted-foreground">Primary venue</span>
            </div>
          </div>
        </> : <>
          {primaryVenue.pool ? <PoolLogo
            token0={poolLogoToken(primaryVenue.pool, primaryVenue.pool.currency0, primaryVenue.pool.currency0Symbol, primaryVenue.pool.currency0LogoUri, displayedToken)}
            token1={poolLogoToken(primaryVenue.pool, primaryVenue.pool.currency1, primaryVenue.pool.currency1Symbol, primaryVenue.pool.currency1LogoUri, displayedToken)}
            chainId={primaryVenue.pool.chainId}
          /> : <span aria-hidden="true" className="h-9 w-9 rounded-full bg-accent" />}
          <div className="min-w-0">
            {primaryVenue.pool
              ? <a className="text-sm font-semibold" href={poolHref(primaryVenue.pool, tokenAddress)}>{pairLabel(primaryVenue.pool, displayedToken)}</a>
              : <p className="text-sm font-semibold">Pons Uniswap V4 pool</p>}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{primaryVenue.protocol.replace('uniswap_', '').toUpperCase()}</Badge>
              <span className="text-xs text-muted-foreground">Pons primary venue</span>
            </div>
          </div>
          {!primaryVenue.pool && <span className="ml-auto max-w-full truncate text-xs text-muted-foreground" title={primaryVenue.poolId}>{primaryVenue.poolId}</span>}
        </>}
      </CardContent>
    </Card></section>}
    {(error || !page) && <p role="alert">Could not load pools.</p>}
    {!tokenAddress && page && <div><h1 className="text-2xl font-semibold">Pools</h1>
      <p className="text-sm text-muted-foreground">Verified indexed Uniswap pools on Robinhood Chain. Supported sources: {page.supportedProtocols.map((p) => p.replace('uniswap_', '')).join(', ')}.</p></div>}
    {items.length === 0 && page && <p>No other verified indexed pools found.</p>}
    {page ? <div role="table" aria-label={tokenAddress ? 'Pools for this token' : 'Pools'} className="w-full overflow-hidden rounded-lg md:table md:table-fixed md:border-separate md:border-spacing-0">
      <div role="rowgroup" className="hidden md:table-header-group">
        <div role="row" className="md:table-row md:h-10 md:bg-card/80 md:backdrop-blur-md [&>div:first-child]:rounded-l-lg [&>div:last-child]:rounded-r-lg">
          <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-[5%] md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">#</div>
          <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-[27%] md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Pool</div>
          {POOL_SORT_COLUMNS.map(({ label, sort, defaultDirection, width }) => {
            const active = sortBy === sort;
            return <div key={sort} role="columnheader" aria-sort={active ? sortDirection === 'asc' ? 'ascending' : 'descending' : undefined}
              className={cn('text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide md:text-right', width, active && 'text-foreground dark:text-white')}>
              <button type="button" className={cn('inline-flex items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', active ? 'text-inherit' : 'text-inherit hover:text-foreground', 'md:ml-auto')}
                onClick={() => {
                  const direction = active ? sortDirection === 'asc' ? 'desc' : 'asc' : defaultDirection;
                  setSortBy(sort);
                  setSortDirection(direction);
                }}>
                {active && <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>} {label}
              </button>
            </div>;
          })}
        </div>
      </div>
      <div role="rowgroup" className="flex flex-col gap-3 p-3 md:table-row-group md:gap-0 md:p-0">
        {sortedItems.map((pool, index) => <div key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`} role="row" className="group relative cursor-pointer rounded-lg bg-transparent p-3 md:table-row md:rounded-none md:bg-transparent md:p-0 md:transition-colors md:hover:bg-transparent">
          <div role="cell" className="pointer-events-none text-foreground md:table-cell md:p-4 md:align-middle">
            <a href={poolHref(pool, tokenAddress ?? pool.displayedToken)} aria-label={`View pool ${pairLabel(pool, displayedToken)}`} className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
            {index + 1}
          </div>
          <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:p-4 md:align-middle">
            <span className="flex items-center gap-3">
              <PoolLogo token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)} token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)} chainId={pool.chainId} />
              <span className="min-w-0"><span className="block text-sm font-medium">{pairLabel(pool, displayedToken)}</span><span className="text-xs text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {pool.fee / 10_000}%{pool.ponsDesignated && ' · Pons designated'}</span></span>
            </span>
          </div>
          {([
            ['FDV', formatPoolUsd(pool.fdvUsd)], ['24H volume', formatPoolUsd(pool.volume24hUsd)], ['Liquidity', formatPoolUsd(pool.tvlUsd)],
            ['1H', <PercentChange key="change1h" value={pool.change1h} />], ['1D', <PercentChange key="change1d" value={pool.change1d} />], ['Age', poolAge(pool.createdTimestamp)],
          ] as const).map(([label, value]) => <div key={label} role="cell" className="pointer-events-none relative z-10 md:table-cell md:p-4 md:text-right md:align-middle">
            <span className="mr-1 text-xs text-muted-foreground md:hidden">{label}</span><span>{value}</span>
          </div>)}
        </div>)}
        {loadingMore && <PoolRowsSkeleton count={6} />}
      </div>
    </div> : null}
    {nextCursor && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
    {loadingMore && <p role="status" className="sr-only">Loading more pools…</p>}
    {loadError && <div className="text-center text-sm"><span role="alert">Could not load more pools. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
  </section>;
}
