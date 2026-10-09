'use client';

import { ChainFilter, ChevronIcon, SelectedCheck, SelectionIcons, toggleValue } from '@/components/chain-filter';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { chainIcon, chainName, ROADMAP_CHAIN_IDS } from '@/api/chains';
import { formatLifecycleStatus, formatQuote, formatUsdCompact, tvlTooltip } from '@/api/format';
import { getLaunches, launchHref, type LaunchPage, type LaunchQuery, type LaunchSummary, type Source } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PercentChange } from '@/components/percent-change';
import { cn } from '@/lib/utils';
import { launchpadName, launchpadIconSrc, LaunchpadIcon } from './launchpad-icon';
import { TokenCell } from './token-cell';

export interface LaunchListProps {
  page: LaunchPage | null;
  sources: readonly Source[];
  error: boolean;
  rankingUnavailable?: boolean;
  chainId?: number | readonly number[];
  search?: string;
  status?: string;
  platform?: string | readonly string[];
  tab?: string;
  sort?: LaunchQuery['sort'];
  direction?: LaunchQuery['direction'];
}

const LIFECYCLE_STATUSES = ['trading', 'swept', 'graduated', 'rescued'] as const;
const TABS = [
  { value: 'all', label: 'All' },
  { value: 'recent', label: 'Recently launched' },
] as const;
const ROADMAP_PLATFORMS = ['pons', 'full.fun', 'bow', 'noxa', 'bankr', 'pools.xyz', 'letscash.fun', 'long', 'varo'] as const;

interface CurrentFilters {
  chainId?: number | readonly number[];
  search?: string;
  status?: string;
  platform?: string | readonly string[];
  tab?: string;
  sort?: LaunchQuery['sort'];
  direction?: LaunchQuery['direction'];
}

const SORT_COLUMNS = [
  { label: 'FDV', sort: 'fdvUsd' },
  { label: '24H volume', sort: 'volume24hUsd' },
  { label: 'Liquidity', sort: 'tvlUsd' },
  { label: '1H', sort: 'change1h' },
  { label: '1D', sort: 'change1d' },
  { label: 'Age', sort: 'recent' },
] as const;
const SORT_COLUMN_WIDTHS = ['md:w-[12%]', 'md:w-[15%]', 'md:w-[12%]', 'md:w-[8%]', 'md:w-[8%]', 'md:w-[7%]'] as const;

function defaultSort(tab: string | undefined): NonNullable<LaunchQuery['sort']> {
  return tab === 'recent' ? 'recent' : 'volume24hUsd';
}

function defaultDirection(sort: LaunchQuery['sort']): NonNullable<LaunchQuery['direction']> {
  return sort === 'recent' ? 'asc' : 'desc';
}

function queryDirection(sort: LaunchQuery['sort'], direction: LaunchQuery['direction']): LaunchQuery['direction'] {
  return direction === defaultDirection(sort) && (sort === 'recent' || sort === 'volume24hUsd') ? undefined : direction;
}

function filterHref(current: CurrentFilters, overrides: CurrentFilters): string {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  if (merged.chainId !== undefined && (!Array.isArray(merged.chainId) || merged.chainId.length)) params.set('chainId', String(merged.chainId));
  if (merged.search) params.set('search', merged.search);
  if (merged.status) params.set('status', merged.status);
  if (merged.platform && (!Array.isArray(merged.platform) || merged.platform.length)) params.set('platform', String(merged.platform));
  if (merged.tab && merged.tab !== 'all') params.set('tab', merged.tab);
  const sort = merged.sort ?? defaultSort(merged.tab);
  if (sort !== defaultSort(merged.tab)) params.set('sort', sort);
  if (merged.direction && merged.direction !== defaultDirection(sort)) params.set('direction', merged.direction);
  return `/launches?${params.toString()}`;
}

function selectedValues<T>(value: T | readonly T[] | undefined): readonly T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value as T];
}


function filtersFromUrl(): CurrentFilters {
  const params = new URLSearchParams(window.location.search);
  const values = (key: string) => params.getAll(key).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const chainIds = [...new Set(values('chainId').map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  return {
    chainId: chainIds,
    platform: [...new Set(values('platform'))],
    search: params.get('search')?.trim() || undefined,
    status: params.get('status') || undefined,
    tab: params.get('tab') === 'recent' ? 'recent' : 'all',
    sort: SORT_COLUMNS.find((column) => column.sort === params.get('sort'))?.sort,
    direction: params.get('direction') === 'asc' || params.get('direction') === 'desc' ? params.get('direction') as 'asc' | 'desc' : undefined,
  };
}

// No date library dependency for a single relative-age cell — see plan Task 7 Step 7.
function formatAge(launchTimestamp: string | null): string {
  if (launchTimestamp === null) return '—';
  const diffSeconds = Math.floor(Date.now() / 1000) - Number(launchTimestamp);
  if (diffSeconds < 60) return `${Math.max(diffSeconds, 0)}s`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diffSeconds / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diffSeconds / 86_400);
  return `${days}d`;
}




function GridIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="shrink-0">
      <rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}


function LaunchpadFilterIcon({ platform }: { platform: string }) {
  return launchpadIconSrc(platform) ? <LaunchpadIcon platform={platform} decorative /> : (
    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase">{launchpadName(platform).slice(0, 2)}</span>
  );
}


function LaunchpadFilter({ platforms, selected, onChange, open, onToggle }: { platforms: readonly string[]; selected: readonly string[]; onChange: (values: string[]) => void; open: boolean; onToggle: () => void }) {
  return (
    <nav aria-label="Filter by launchpad">
      <details name="launch-filters" open={open} className="group relative">
        <summary onClick={(event) => { event.preventDefault(); onToggle(); }} aria-label={selected.length ? `Selected launchpads: ${selected.map(launchpadName).join(', ')}` : 'All launchpads'} className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-input bg-transparent px-4 py-2 text-sm capitalize [&::-webkit-details-marker]:hidden">
          {selected.length > 0 && <SelectionIcons values={selected} icon={(value) => <LaunchpadFilterIcon platform={String(value)} />} />}
          {selected.length === 0 ? 'All launchpads' : selected.length === 1 ? launchpadName(selected[0]) : null}
          <ChevronIcon />
        </summary>
        <div data-filter-menu className="absolute right-0 z-10 mt-2 max-h-[60vh] w-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-md">
          <button type="button" onClick={() => onChange([])} aria-pressed={!selected.length} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
            <span className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center"><GridIcon /></span> All launchpads</span>
            {!selected.length && <SelectedCheck />}
          </button>
          {platforms.map((value) => (
            <button key={value} type="button" onClick={() => onChange(toggleValue(selected, value))} aria-pressed={selected.includes(value)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm capitalize hover:bg-muted">
              <span className="flex items-center gap-2"><LaunchpadFilterIcon platform={value} /> {launchpadName(value)}</span>
              {selected.includes(value) && <SelectedCheck />}
            </button>
          ))}
        </div>
      </details>
    </nav>
  );
}


function LaunchRowsSkeleton({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div key={index} role="row" aria-hidden="true" data-testid="launch-skeleton-row"
      className="min-h-[266px] rounded-lg border border-border bg-card p-3 md:table-row md:h-[76px] md:min-h-0 md:rounded-none md:border-0 md:border-b md:bg-transparent md:p-0">
      <div role="cell" className="md:table-cell md:p-4"><span className="block h-4 w-4 animate-pulse rounded bg-muted" /></div>
      <div role="cell" className="md:table-cell md:p-4">
        <span className="flex items-center gap-2">
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="grid gap-1.5"><span className="h-3 w-24 animate-pulse rounded bg-muted" /><span className="h-2.5 w-14 animate-pulse rounded bg-muted" /></span>
        </span>
      </div>
      <div role="cell" className="md:table-cell md:p-4"><span className="block h-4 w-20 animate-pulse rounded bg-muted" /></div>
      {['w-16', 'w-20', 'w-16', 'w-12', 'w-12', 'w-12', 'w-10'].map((width, cell) => (
        <div key={cell} role="cell" className="md:table-cell md:p-4 md:text-right">
          <span className={cn('ml-auto block h-4 animate-pulse rounded bg-muted', width)} />
        </div>
      ))}
    </div>
  ));
}

export function LaunchList({ page, sources, error, rankingUnavailable = false, chainId, search, status, platform, tab, sort: initialSort, direction: initialDirection }: LaunchListProps) {
  const [items, setItems] = useState<readonly LaunchSummary[]>(page?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(page?.nextCursor ?? null);
  const [selectedChains, setSelectedChains] = useState<readonly number[]>(selectedValues(chainId));
  const [selectedPlatforms, setSelectedPlatforms] = useState<readonly string[]>(selectedValues(platform));
  const [activeTab, setActiveTab] = useState(tab === 'recent' ? 'recent' : 'all');
  const [sortBy, setSortBy] = useState<NonNullable<LaunchQuery['sort']>>(initialSort ?? defaultSort(tab));
  const [sortDirection, setSortDirection] = useState<NonNullable<LaunchQuery['direction']>>(initialDirection ?? defaultDirection(initialSort ?? defaultSort(tab)));
  const [appliedSearch, setAppliedSearch] = useState(search);
  const [searchDraft, setSearchDraft] = useState(search ?? '');
  const [selectedStatus, setSelectedStatus] = useState(status);
  const [filtering, setFiltering] = useState(false);
  const [filterError, setFilterError] = useState(false);
  const [openFilter, setOpenFilter] = useState<'launchpad' | 'chain' | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const filterRevisionRef = useRef(0);
  const current: CurrentFilters = { chainId: selectedChains, search: appliedSearch, status: selectedStatus, platform: selectedPlatforms, tab: activeTab, sort: sortBy, direction: sortDirection };

  const refreshFilters = useCallback(async (next: CurrentFilters, updateUrl = true) => {
    const chains = selectedValues(next.chainId);
    const platforms = selectedValues(next.platform);
    const nextTab = next.tab === 'recent' ? 'recent' : 'all';
    const nextSort = next.sort ?? defaultSort(nextTab);
    const nextDirection = next.direction ?? defaultDirection(nextSort);
    if (updateUrl && chains.join(',') === selectedChains.join(',') && platforms.join(',') === selectedPlatforms.join(',')
      && next.search === appliedSearch && next.status === selectedStatus && nextTab === activeTab && nextSort === sortBy && nextDirection === sortDirection) return;
    const revision = ++filterRevisionRef.current;
    setSelectedChains(chains);
    setSelectedPlatforms(platforms);
    setActiveTab(nextTab);
    setSortBy(nextSort);
    setSortDirection(nextDirection);
    setAppliedSearch(next.search);
    setSelectedStatus(next.status);
    setNextCursor(null);
    setLoadError(false);
    setFilterError(false);
    setFiltering(true);
    if (updateUrl) window.history.pushState(null, '', filterHref({ chainId: chains, platform: platforms, search: next.search, status: next.status, tab: nextTab, sort: nextSort, direction: nextDirection }, {}));
    try {
      const filteredPage = await getLaunches({ chainId: chains.length ? chains : undefined, platform: platforms.length ? platforms : undefined,
        search: next.search, status: next.status, sort: nextSort, ...(queryDirection(nextSort, nextDirection) ? { direction: nextDirection } : {}) });
      if (revision !== filterRevisionRef.current) return;
      setItems(filteredPage.items);
      setNextCursor(filteredPage.nextCursor);
    } catch {
      if (revision !== filterRevisionRef.current) return;
      setItems([]);
      setFilterError(true);
    } finally {
      if (revision === filterRevisionRef.current) setFiltering(false);
    }
  }, [selectedChains, selectedPlatforms, appliedSearch, selectedStatus, activeTab, sortBy, sortDirection]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    const revision = filterRevisionRef.current;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = await getLaunches({ cursor: nextCursor, chainId: selectedChains.length ? selectedChains : undefined,
        search: appliedSearch, status: selectedStatus, platform: selectedPlatforms.length ? selectedPlatforms : undefined, sort: sortBy,
        ...(queryDirection(sortBy, sortDirection) ? { direction: sortDirection } : {}) });
      if (revision !== filterRevisionRef.current) return;
      setItems((currentItems) => [...currentItems, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      if (revision === filterRevisionRef.current) setLoadError(true);
    } finally {
      loadingRef.current = false;
      if (revision === filterRevisionRef.current) setLoadingMore(false);
    }
  }, [nextCursor, appliedSearch, selectedChains, selectedPlatforms, selectedStatus, sortBy, sortDirection]);

  useEffect(() => {
    // Reset client filters when the server supplies a new page (including a direct URL visit).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(page?.items ?? []);
    setNextCursor(page?.nextCursor ?? null);
    setLoadError(false);
    setSelectedChains(selectedValues(chainId));
    setSelectedPlatforms(selectedValues(platform));
    setActiveTab(tab === 'recent' ? 'recent' : 'all');
    setSortBy(initialSort ?? defaultSort(tab));
    setSortDirection(initialDirection ?? defaultDirection(initialSort ?? defaultSort(tab)));
    setAppliedSearch(search);
    setSearchDraft(search ?? '');
    setSelectedStatus(status);
    setFilterError(false);
    setFiltering(false);
  }, [page, chainId, platform, search, status, tab, initialSort, initialDirection]);

  useEffect(() => {
    const onPopState = () => {
      const next = filtersFromUrl();
      setSearchDraft(next.search ?? '');
      void refreshFilters(next, false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [refreshFilters]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadError, loadMore, nextCursor]);

  if (error || !page) {
    if (rankingUnavailable) {
      return (
        <div role="status">
          <p>Official volume ranking is updating and will be back shortly. Recently listed launches are still available.</p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see the error branch below */}
          <a href="/launches?tab=recent">Browse recent launches</a>{' '}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the error fallback needs a fresh server request */}
          <a href="/launches">Retry</a>
        </div>
      );
    }
    return (
      <div role="alert">
        <p>Could not load the launch list from the server. Please try again.</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain <a> keeps this
            component router-context-free for unit tests (see Task 2 ruling in the plan ledger);
            clicking it still does a real navigation/refetch since fetches use cache: 'no-store'. */}
        <a href="/launches">Retry</a>
      </div>
    );
  }

  const chainIds = [...new Set([...ROADMAP_CHAIN_IDS, ...sources.map((source) => source.chainId), ...selectedChains])];
  const platforms = [...new Set([...ROADMAP_PLATFORMS, ...sources.map((source) => source.platform), ...selectedPlatforms])];
  const freshestAsOf = items.map((item) => item.officialVolume24hUsdAsOf).filter((value): value is string => value !== null).sort().at(-1) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <form method="get" role="search" aria-label="Search and filter launches" onSubmit={(event) => {
        event.preventDefault();
        void refreshFilters({ ...current, search: searchDraft.trim() || undefined });
      }} className="flex flex-wrap gap-2">
        <Input
          type="search"
          name="search"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="Search by name or symbol"
          aria-label="Search launches"
          className="max-w-xs"
        />
        <select
          name="status"
          value={selectedStatus ?? ''}
          onChange={(event) => { void refreshFilters({ ...current, status: event.target.value || undefined }); }}
          aria-label="Filter by lifecycle"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All statuses</option>
          {LIFECYCLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {formatLifecycleStatus(value)}
            </option>
          ))}
        </select>
        {selectedChains.length > 0 && <input type="hidden" name="chainId" value={selectedChains.join(',')} />}
        {selectedPlatforms.length > 0 && <input type="hidden" name="platform" value={selectedPlatforms.join(',')} />}
        {activeTab !== 'all' && <input type="hidden" name="tab" value={activeTab} />}
        <Button type="submit">Search</Button>
      </form>

      {activeTab === 'all' && freshestAsOf !== null && (
        <p className="text-xs text-muted-foreground">Official 24h volume as of {freshestAsOf.replace('T', ' ').slice(0, 16)} UTC</p>
      )}
      <div className="relative z-20 flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Filter by tab" className="flex gap-2">
          {TABS.map(({ value, label }) => (
            <a
              key={value}
              href={filterHref(current, { tab: value, sort: defaultSort(value), direction: defaultDirection(defaultSort(value)) })}
              onClick={(event) => { event.preventDefault(); void refreshFilters({ ...current, tab: value, sort: defaultSort(value), direction: defaultDirection(defaultSort(value)) }); }}
              aria-current={activeTab === value ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1 text-sm transition-colors',
                activeTab === value
                  ? 'bg-foreground/10 text-foreground hover:bg-foreground/15 dark:bg-white/10 dark:text-white dark:hover:bg-white/15'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LaunchpadFilter platforms={platforms} selected={selectedPlatforms} onChange={(values) => { void refreshFilters({ ...current, platform: values }); }} open={openFilter === 'launchpad'} onToggle={() => setOpenFilter((currentFilter) => currentFilter === 'launchpad' ? null : 'launchpad')} />
          <ChainFilter chainIds={chainIds} selected={selectedChains} onChange={(values) => { void refreshFilters({ ...current, chainId: values }); }} open={openFilter === 'chain'} onToggle={() => setOpenFilter((currentFilter) => currentFilter === 'chain' ? null : 'chain')} />
        </div>
      </div>

      {filtering && <p role="status" className="sr-only">Updating launches…</p>}
      {filterError && <div role="alert" className="text-sm">Could not update launches. <button type="button" className="underline" onClick={() => { void refreshFilters(current, false); }}>Retry</button></div>}

      <div role="table" aria-label="Launch list" aria-busy={filtering || loadingMore} className="relative z-0 w-full overflow-hidden rounded-lg border border-border md:table md:table-fixed md:border-separate md:border-spacing-0">
        <div role="rowgroup" className="hidden bg-muted md:table-header-group">
          <div role="row" className="md:table-row">
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-[4%] md:px-2 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide lg:px-4">#</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-[22%] md:px-2 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide lg:px-4">Token</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-[12%] md:px-2 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide lg:px-4">Launchpad</div>
            {SORT_COLUMNS.map(({ label, sort }, index) => {
              const active = sortBy === sort;
              return (
                <div key={sort} role="columnheader" aria-sort={active ? sortDirection === 'asc' ? 'ascending' : 'descending' : undefined}
                  className={cn('text-muted-foreground md:table-cell md:h-10 md:px-2 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide lg:px-4', SORT_COLUMN_WIDTHS[index],
                    active && 'text-white')}>
                  <button type="button" className={cn('inline-flex items-center gap-1 text-inherit focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', active ? 'hover:text-white' : 'hover:text-foreground')}
                    onClick={() => {
                      const direction = active ? sortDirection === 'asc' ? 'desc' : 'asc' : defaultDirection(sort);
                      void refreshFilters({ ...current, tab: sort === 'recent' ? 'recent' : 'all', sort, direction });
                    }}>
                    {active && <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>} {label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-3 p-3 md:table-row-group md:gap-0 md:p-0">
          {filtering && items.length === 0 ? <LaunchRowsSkeleton count={8} /> : items.map((launch, index) => {
            return (
              <div
                key={`${launch.chainId}-${launch.tokenAddress}`}
                role="row"
                className={cn(
                  'group relative cursor-pointer rounded-lg border border-border bg-card p-3',
                  'md:table-row md:rounded-none md:border-0 md:border-b md:border-border md:bg-transparent md:p-0 md:transition-colors md:hover:bg-muted/60',
                )}
              >
                <div role="cell" className="pointer-events-none text-foreground md:table-cell md:w-[4%] md:p-2 md:align-middle lg:p-4">
                  <a
                    href={launchHref(launch.chainId, launch.tokenAddress)}
                    aria-label={`View ${launch.name ?? launch.tokenAddress} details`}
                    className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                  {index + 1}
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[22%] md:p-2 md:align-middle lg:p-4">
                  <TokenCell chainId={launch.chainId} tokenAddress={launch.tokenAddress} name={launch.name}
                    symbol={launch.symbol} logoUri={launch.logoUri} />
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[12%] md:p-2 md:align-middle lg:p-4">
                  <span className="inline-flex items-center gap-2" title={`${launchpadName(launch.platform)} ${launch.protocolVersion}`}>
                    <LaunchpadIcon platform={launch.platform} />
                    <span>{launchpadName(launch.platform)}</span>
                  </span>
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[12%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">FDV</span>
                  <span>{formatUsdCompact(launch.fdvUsd, 1)}</span>
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[15%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">24H volume</span>
                  <span title={formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}>
                    {launch.officialVolume24hUsd !== null ? `~${formatUsdCompact(launch.officialVolume24hUsd, 1)}` : formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
                  </span>
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[12%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Liquidity</span>
                  <span title={tvlTooltip(launch)}>{formatUsdCompact(launch.tvlUsd, 1)}</span>
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[8%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1H</span>
                  <span><PercentChange value={launch.change1h} /></span>
                </div>
                <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:w-[8%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1D</span>
                  <span><PercentChange value={launch.change1d} /></span>
                </div>
                <div role="cell" className="md:table-cell md:w-[7%] md:p-2 md:text-right md:align-middle lg:p-4">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Age</span>
                  <span className="text-muted-foreground">{formatAge(launch.launchTimestamp)}</span>
                </div>
              </div>
            );
          })}
          {loadingMore && !filtering && <LaunchRowsSkeleton count={6} />}
        </div>
      </div>

      {!filtering && !filterError && items.length === 0 && <p role="status" className="text-center text-sm text-muted-foreground">No launches match these filters yet.</p>}

      {nextCursor && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
      {loadingMore && <p role="status" className="sr-only">Loading more launches…</p>}
      {loadError && <div className="text-center text-sm"><span role="alert">Could not load more launches. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
    </div>
  );
}
