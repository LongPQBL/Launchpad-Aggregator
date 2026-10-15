'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLaunchPools, getPools, poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { PageHeading } from '@/components/page-heading';
import { PoolLogo, type PoolLogoToken } from './pool-logo';
import { useLiveFirstPage } from '@/hooks/use-live-first-page';
import { POOL_CHANGED_EVENT } from '@/hooks/live-events';
import { mergeRefreshedPage, refreshRowsInPlace } from '@/lib/merge-refreshed-page';
import { cn } from '@/lib/utils';
import { poolColumnWidth, type PoolColumnId } from './pool-columns';
import { formatPoolFee, formatPoolUsd, formatVolumeToTvl, isHighFeePool, poolAge, short, volumeToTvl } from './pool-format';
import { RollingText } from '@/components/percent-change';

function side(address: string): string { return address.toLowerCase(); }

export interface PoolListDisplayedToken { address: string; symbol: string; logoUri: string | null }
export type PrimaryLaunchVenue =
  | { kind: 'curve'; token: PoolListDisplayedToken; quoteSymbol: string; chainId: number;
      /** The launch's official 24 h USD volume and its launch time (unix seconds); null when unavailable. A curve has no TVL. */
      volume24hUsd?: string | null; launchTimestamp?: number | null }
  | { kind: 'pool'; pool: PoolSummary | null; poolId: string; protocol: string };

const HIDE_HIGH_FEE_KEY = 'hideHighFeePools';

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

function poolKey(pool: PoolSummary): string {
  return `${pool.chainId}:${pool.protocol}:${pool.poolId}`;
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
  // Show every pool by default; the reader can hide the high-fee ones (kept in this browser).
  const [hideHighFee, setHideHighFee] = useState(false);
  const hideHighFeeRef = useRef(false);
  useEffect(() => { hideHighFeeRef.current = hideHighFee; }, [hideHighFee]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  // The order is decided when the user sorts, a page is added, or the list changes size - never by a live
  // refresh, which only updates the numbers of the rows already placed.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });
  const order = useMemo(() => {
    const keys = items.map(poolKey);
    if (sortBy === null) return keys;
    const byKey = new Map(items.map((pool) => [poolKey(pool), pool]));
    return [...items].sort((a, b) => {
      const left = poolSortValue(a, sortBy);
      const right = poolSortValue(b, sortBy);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      const comparison = left - right;
      return sortDirection === 'asc' ? comparison : -comparison;
    }).map((pool) => poolKey(byKey.get(poolKey(pool))!));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, sortBy, sortDirection]);
  const sortedItems = useMemo(() => {
    const byKey = new Map(items.map((pool) => [poolKey(pool), pool]));
    const placed = order.flatMap((key) => byKey.get(key) ?? []);
    const placedKeys = new Set(order);
    return [...placed, ...items.filter((pool) => !placedKeys.has(poolKey(pool)))];
  }, [items, order]);
  // The launch's official Pons pool is pinned to the top of the list (not shown as a separate card).
  const rowKey = poolKey;
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
  // The official Pons pool is never hidden, whatever its fee tier says.
  const shownRows = hideHighFee ? displayedRows.filter((pool) => isOfficial(pool) || !isHighFeePool(pool.fee)) : displayedRows;
  const highFeeCount = displayedRows.filter((pool) => !isOfficial(pool) && isHighFeePool(pool.fee)).length;

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

  // A swap announced in a listed pool refreshes the numbers of the rows on screen in place (no reshuffling,
  // no new rows); the page-wide router.refresh() still brings in pools created since.
  useLiveFirstPage(
    // A swap in a pool on this list matters. On a token's own list, so does the first swap of a pool that holds the
    // token but is not listed yet (it may be a new pool). Any other pool's swap leaves these rows unchanged.
    (payload) => payload.poolId !== undefined && (
      itemsRef.current.some((pool) => pool.chainId === payload.chainId && pool.poolId.toLowerCase() === payload.poolId)
      || (tokenAddress !== undefined && chainId === payload.chainId && payload.poolTokens?.includes(tokenAddress.toLowerCase()) === true)),
    async (isStale) => {
      if (tokenAddress && chainId === undefined) return;
      const fresh = tokenAddress
        ? await getLaunchPools(chainId!, tokenAddress, { excludeOfficial: true, hideHighFee: hideHighFeeRef.current || undefined })
        : await getPools({ chainId, hideHighFee: hideHighFeeRef.current || undefined });
      if (isStale()) return;
      setItems((shown) => refreshRowsInPlace(fresh.items, shown, rowKey, false, tokenAddress !== undefined));
    },
    [chainId, tokenAddress],
    POOL_CHANGED_EVENT,
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current || (tokenAddress && chainId === undefined)) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = tokenAddress
        ? await getLaunchPools(chainId!, tokenAddress, { cursor: nextCursor, excludeOfficial: true, hideHighFee: hideHighFee || undefined })
        : await getPools({ cursor: nextCursor, chainId, hideHighFee: hideHighFee || undefined });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [chainId, hideHighFee, nextCursor, tokenAddress]);

  // The switch: remember it, and read the first page again with or without the high-fee pools so the pages that follow are not mostly hidden rows.
  const applyHideHighFee = useCallback(async (hide: boolean) => {
    setHideHighFee(hide);
    hideHighFeeRef.current = hide;
    try { window.localStorage.setItem(HIDE_HIGH_FEE_KEY, hide ? 'true' : 'false'); } catch { /* not persisted */ }
    if (tokenAddress && chainId === undefined) return;
    try {
      const first = tokenAddress ? await getLaunchPools(chainId!, tokenAddress, { excludeOfficial: true, hideHighFee: hide }) : await getPools({ chainId, hideHighFee: hide });
      if (hideHighFeeRef.current !== hide) return; // the switch was flipped again meanwhile
      setItems(first.items);
      setNextCursor(first.nextCursor);
      setLoadError(false);
    } catch { setLoadError(true); }
  }, [chainId, tokenAddress]);
  useEffect(() => {
    // After the first render, never inside the effect body: the remembered choice is applied as an ordinary update.
    try { if (window.localStorage.getItem(HIDE_HIGH_FEE_KEY) === 'true') void Promise.resolve().then(() => applyHideHighFee(true)); } catch { /* not readable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once on mount
  }, []);

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
    {page && (highFeeCount > 0 || hideHighFee) && (
      <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
        <button type="button" role="switch" aria-checked={hideHighFee} aria-label="Hide high-fee pools" onClick={() => void applyHideHighFee(!hideHighFee)}
          className={cn('relative h-5 w-9 cursor-pointer rounded-full border border-border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', hideHighFee ? 'bg-brand' : 'bg-muted')}>
          <span aria-hidden="true" className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-foreground transition-all', hideHighFee ? 'left-[1.15rem]' : 'left-0.5')} />
        </button>
        <span>Hide high-fee pools <span className="text-xs">(fee 10% or more{hideHighFee ? '' : `, ${highFeeCount} shown`})</span></span>
      </div>
    )}
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
          {([['TVL', '—'], ['24H Volume', formatPoolUsd(curveRow.volume24hUsd ?? null)], ['30D Volume', '—'], ['1D Vol/TVL', '—'], ['Age', poolAge(curveRow.launchTimestamp ?? null)]] as const).map(([label, value]) => <div key={label} role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:text-right md:align-middle"><span className="mr-1 text-xs text-muted-foreground md:hidden">{label}</span><span>{value}</span></div>)}
        </div>}
        {shownRows.map((pool, index) => <div key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`} role="row" className="group relative cursor-pointer rounded-lg bg-transparent p-3 md:table-row md:h-[60px] md:rounded-none md:bg-transparent md:p-0 md:transition-colors md:hover:bg-transparent">
          <div role="cell" className={cn('pointer-events-none text-foreground md:table-cell md:px-4 md:py-0 md:align-middle')}>
            <Link href={poolHref(pool, tokenAddress ?? pool.displayedToken)} aria-label={`View pool ${pairLabel(pool, displayedToken)}`} className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
            {index + 1 + (curveRow ? 1 : 0)}
          </div>
          <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:px-4 md:py-0 md:align-middle">
            <span className="flex items-center gap-3">
              <PoolLogo size="small" token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)} token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)} chainId={pool.chainId} />
              <span className="min-w-0"><span className="block text-base">{pairLabel(pool, displayedToken)}</span><span className="text-sm text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {formatPoolFee(pool.fee, pool.hooks)}{isHighFeePool(pool.fee) && <span className="text-destructive"> · High fee</span>}{isOfficial(pool) && ' · Official Pons pool'}</span></span>
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
