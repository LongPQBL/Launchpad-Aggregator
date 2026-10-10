'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLaunchPools, getPools, poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { PageHeading } from '@/components/page-heading';
import { PoolLogo, type PoolLogoToken } from './pool-logo';
import { mergeRefreshedPage } from '@/lib/merge-refreshed-page';
import { cn } from '@/lib/utils';
import { poolColumnWidth, type PoolColumnId } from './pool-columns';
import { formatPoolUsd, formatVolumeToTvl, poolAge, short, volumeToTvl } from './pool-format';
import { RollingText } from '@/components/percent-change';

function side(address: string): string { return address.toLowerCase(); }

export interface PoolListDisplayedToken { address: string; symbol: string; logoUri: string | null }
export type PrimaryLaunchVenue =
  | { kind: 'curve'; token: PoolListDisplayedToken; quoteSymbol: string; chainId: number }
  | { kind: 'pool'; pool: PoolSummary | null; poolId: string; protocol: string };

type PoolSort = 'volume24hUsd' | 'tvlUsd' | 'volume30dUsd' | 'volumeToTvl' | 'age';
const POOL_SORT_COLUMNS: { label: string; sort: PoolSort; defaultDirection: 'asc' | 'desc'; column: PoolColumnId }[] = [
  { label: 'TVL', sort: 'tvlUsd', defaultDirection: 'desc', column: 'tvl' },
  { label: '24H Volume', sort: 'volume24hUsd', defaultDirection: 'desc', column: 'volume24h' },
  { label: '30D Volume', sort: 'volume30dUsd', defaultDirection: 'desc', column: 'volume30d' },
  { label: '1D Vol/TVL', sort: 'volumeToTvl', defaultDirection: 'desc', column: 'volumeToTvl' },
  { label: 'Age', sort: 'age', defaultDirection: 'asc', column: 'age' },
];

function poolSortValue(pool: PoolSummary, sort: PoolSort): number | null {
  if (sort === 'age') return pool.createdTimestamp === null ? null : -pool.createdTimestamp;
  if (sort === 'volumeToTvl') return volumeToTvl(pool);
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
// Mirrors LaunchRowsSkeleton in launches/launch-list.tsx: pulsing placeholder rows in the table's own layout, each bar
// spanning its column.
const POOL_SKELETON_NUMERIC_CELLS = 5;

function PoolRowsSkeleton({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div key={index} role="row" aria-hidden="true" data-testid="pool-skeleton-row" className="rounded-lg p-3 md:table-row md:h-[60px] md:rounded-none md:p-0">
      <div role="cell" className="md:table-cell md:px-4 md:py-0 md:align-middle"><span className="block h-4 w-4 animate-pulse rounded bg-muted" /></div>
      <div role="cell" className="md:table-cell md:px-4 md:py-0 md:align-middle">
        <span className="flex items-center gap-3">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex flex-col gap-1.5">
            <span className="block h-4 w-36 max-w-full animate-pulse rounded bg-muted" />
            <span className="block h-3 w-20 max-w-full animate-pulse rounded bg-muted" />
          </span>
        </span>
      </div>
      {Array.from({ length: POOL_SKELETON_NUMERIC_CELLS }, (_, cell) => (
        <div key={cell} role="cell" className="md:table-cell md:px-4 md:py-0 md:text-right md:align-middle">
          <span className={`ml-auto block h-4 max-w-full animate-pulse rounded bg-muted ${['w-14', 'w-14', 'w-14', 'w-10', 'w-8'][cell]}`} />
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
  // The launch's official Pons pool is pinned to the top of the list (not shown as a separate card).
  const rowKey = (pool: PoolSummary) => `${pool.chainId}:${pool.protocol}:${pool.poolId}`;
  const officialKey = primaryVenue?.kind === 'pool' && primaryVenue.pool ? rowKey(primaryVenue.pool) : null;
  const isOfficial = (pool: PoolSummary) => pool.ponsDesignated || rowKey(pool) === officialKey;
  const displayedRows = useMemo(() => {
    const official = sortedItems.filter(isOfficial);
    const rest = sortedItems.filter((pool) => !isOfficial(pool));
    const pinned = primaryVenue?.kind === 'pool' && primaryVenue.pool && !official.some((pool) => rowKey(pool) === officialKey)
      ? [primaryVenue.pool] : [];
    return [...pinned, ...official, ...rest];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedItems, primaryVenue]);
  const curveRow = primaryVenue?.kind === 'curve' ? primaryVenue : null;

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
    {(error || !page) && <p role="alert">Could not load pools.</p>}
    {!tokenAddress && page && <PageHeading title="Pools" />}
    {items.length === 0 && !primaryVenue && page && <p>No other verified indexed pools found.</p>}
    {page ? <div role="table" aria-label={tokenAddress ? 'Pools for this token' : 'Pools'} className="w-full overflow-hidden rounded-lg md:table md:table-fixed md:border-separate md:border-spacing-0">
      <div role="rowgroup" className="hidden md:table-header-group">
        <div role="row" className="md:table-row md:h-10 md:[&>div]:bg-muted [&>div:first-child]:rounded-l-lg [&>div:last-child]:rounded-r-lg">
          <div role="columnheader" style={{ width: poolColumnWidth('index') }} className={cn('text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-sm')}>#</div>
          <div role="columnheader" style={{ width: poolColumnWidth('pool') }} className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-sm  ">Pool</div>
          {POOL_SORT_COLUMNS.map(({ label, sort, defaultDirection, column }) => {
            const active = sortBy === sort;
            return <div key={sort} role="columnheader" style={{ width: poolColumnWidth(column) }} aria-sort={active ? sortDirection === 'asc' ? 'ascending' : 'descending' : undefined}
              className={cn('text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-sm  md:text-right', active && 'text-foreground dark:text-white')}>
              <button type="button" className={cn('flex items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', active ? 'text-inherit' : 'text-inherit hover:text-foreground', 'md:ml-auto')}
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
        {curveRow && <div role="row" className="group relative cursor-pointer rounded-lg bg-transparent p-3 md:table-row md:h-[60px] md:rounded-none md:p-0">
          <div role="cell" className="pointer-events-none text-foreground md:table-cell md:px-4 md:py-0 md:align-middle">
            <Link href={`/launches/${curveRow.chainId}/${curveRow.token.address}/curve`} aria-label={`View bonding curve ${curveRow.token.symbol} / ${curveRow.quoteSymbol}`} className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
            1
          </div>
          <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:align-middle">
            <span className="flex items-center gap-3">
              <PoolLogo size="small" token0={{ symbol: curveRow.token.symbol, logoUri: curveRow.token.logoUri }} token1={{ symbol: curveRow.quoteSymbol, logoUri: null }} chainId={curveRow.chainId} />
              <span className="min-w-0"><span className="block text-base">{curveRow.token.symbol} / {curveRow.quoteSymbol}</span><span className="text-sm text-muted-foreground">Bonding curve · Official Pons pool</span></span>
            </span>
          </div>
          {['TVL', '24H Volume', '30D Volume', '1D Vol/TVL', 'Age'].map((label) => <div key={label} role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:text-right md:align-middle"><span className="mr-1 text-xs text-muted-foreground md:hidden">{label}</span><span>—</span></div>)}
        </div>}
        {displayedRows.map((pool, index) => <div key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`} role="row" className="group relative cursor-pointer rounded-lg bg-transparent p-3 md:table-row md:h-[60px] md:rounded-none md:bg-transparent md:p-0 md:transition-colors md:hover:bg-transparent">
          <div role="cell" className={cn('pointer-events-none text-foreground md:table-cell md:px-4 md:py-0 md:align-middle')}>
            <Link href={poolHref(pool, tokenAddress ?? pool.displayedToken)} aria-label={`View pool ${pairLabel(pool, displayedToken)}`} className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
            {index + 1 + (curveRow ? 1 : 0)}
          </div>
          <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:align-middle">
            <span className="flex items-center gap-3">
              <PoolLogo size="small" token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)} token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)} chainId={pool.chainId} />
              <span className="min-w-0"><span className="block text-base">{pairLabel(pool, displayedToken)}</span><span className="text-sm text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {pool.fee / 10_000}%{isOfficial(pool) && ' · Official Pons pool'}</span></span>
            </span>
          </div>
          {([
            ['TVL', formatPoolUsd(pool.tvlUsd), pool.tvlUsd], ['24H Volume', formatPoolUsd(pool.volume24hUsd), pool.volume24hUsd],
            ['30D Volume', formatPoolUsd(pool.volume30dUsd), pool.volume30dUsd], ['1D Vol/TVL', formatVolumeToTvl(volumeToTvl(pool)), volumeToTvl(pool)], ['Age', poolAge(pool.createdTimestamp), null],
          ] as const).map(([label, value, raw]) => <div key={label} role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:text-right md:align-middle">
            <span className="mr-1 text-xs text-muted-foreground md:hidden">{label}</span><span><RollingText text={value} value={raw} flash={label !== 'Age'} /></span>
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
