import { chainIcon, chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote, formatUsd, tvlTooltip } from '@/api/format';
import { launchHref, type LaunchPage, type Source } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PercentChange } from '@/components/percent-change';
import { cn } from '@/lib/utils';
import { LaunchpadIcon } from './launchpad-icon';
import { TokenCell } from './token-cell';

export interface LaunchListProps {
  page: LaunchPage | null;
  sources: readonly Source[];
  error: boolean;
  rankingUnavailable?: boolean;
  chainId?: number;
  search?: string;
  status?: string;
  platform?: string;
  tab?: string;
}

const LIFECYCLE_STATUSES = ['trading', 'swept', 'graduated', 'rescued'] as const;
const TABS = [
  { value: 'all', label: 'All' },
  { value: 'recent', label: 'Recently launched' },
] as const;

interface CurrentFilters {
  chainId?: number;
  search?: string;
  status?: string;
  platform?: string;
  tab?: string;
}

function filterHref(current: CurrentFilters, overrides: CurrentFilters): string {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  if (merged.chainId !== undefined) params.set('chainId', String(merged.chainId));
  if (merged.search) params.set('search', merged.search);
  if (merged.status) params.set('status', merged.status);
  if (merged.platform) params.set('platform', merged.platform);
  if (merged.tab && merged.tab !== 'all') params.set('tab', merged.tab);
  return `/?${params.toString()}`;
}

function nextPageHref(cursor: string, current: CurrentFilters): string {
  const params = new URLSearchParams({ cursor });
  if (current.chainId !== undefined) params.set('chainId', String(current.chainId));
  if (current.search) params.set('search', current.search);
  if (current.status) params.set('status', current.status);
  if (current.platform) params.set('platform', current.platform);
  if (current.tab && current.tab !== 'all') params.set('tab', current.tab);
  return `/?${params.toString()}`;
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

function ChevronIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none" className="shrink-0">
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="shrink-0">
      <rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function LaunchpadFilter({ platforms, current, selected }: { platforms: readonly string[]; current: CurrentFilters; selected?: string }) {
  const label = selected ?? 'All launchpads';
  return (
    <nav aria-label="Filter by launchpad">
      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-input bg-transparent px-4 py-2 text-sm capitalize [&::-webkit-details-marker]:hidden">
          {selected && <LaunchpadIcon platform={selected} />}
          {label}
          <ChevronIcon />
        </summary>
        <div className="absolute z-10 mt-2 w-56 rounded-lg border border-border bg-popover p-1 shadow-md">
          <a href={filterHref(current, { platform: undefined })} className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted">
            <span className="flex items-center gap-2"><GridIcon /> All launchpads</span>
            {!selected && <CheckIcon />}
          </a>
          {platforms.map((value) => (
            <a key={value} href={filterHref(current, { platform: value })} className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm capitalize hover:bg-muted">
              <span className="flex items-center gap-2"><LaunchpadIcon platform={value} /> {value}</span>
              {selected === value && <CheckIcon />}
            </a>
          ))}
        </div>
      </details>
    </nav>
  );
}

function ChainFilter({ chainIds, current, selected }: { chainIds: readonly number[]; current: CurrentFilters; selected?: number }) {
  return (
    <nav aria-label="Filter by chain">
      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-input bg-transparent px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
          {chainIcon(selected ?? chainIds[0] ?? 4663) && (
            // eslint-disable-next-line @next/next/no-img-element -- small fixed-size chain icon, not worth next/image's overhead here
            <img src={chainIcon(selected ?? chainIds[0] ?? 4663)} alt="" width={18} height={18} className="h-[18px] w-[18px] rounded-full" />
          )}
          <ChevronIcon />
        </summary>
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-lg border border-border bg-popover p-2 shadow-md">
          {chainIds.map((id) => (
            <a key={id} href={filterHref(current, { chainId: id })} className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted">
              <span className="flex items-center gap-2">
                {chainIcon(id) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={chainIcon(id)} alt="" width={20} height={20} className="h-5 w-5 rounded-full" />
                )}
                {chainName(id)}
                <Badge variant="secondary" className="bg-primary/10 text-primary">New</Badge>
              </span>
              {(selected ?? chainIds[0]) === id && <CheckIcon />}
            </a>
          ))}
          <p className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">More chains coming soon</p>
        </div>
      </details>
    </nav>
  );
}

export function LaunchList({ page, sources, error, rankingUnavailable = false, chainId, search, status, platform, tab }: LaunchListProps) {
  if (error || !page) {
    if (rankingUnavailable) {
      return (
        <div role="status">
          <p>Official volume ranking is updating and will be back shortly. Recently listed launches are still available.</p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see the error branch below */}
          <a href="/?tab=recent">Browse recent launches</a>{' '}
          <a href="/">Retry</a>
        </div>
      );
    }
    return (
      <div role="alert">
        <p>Could not load the launch list from the server. Please try again.</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain <a> keeps this
            component router-context-free for unit tests (see Task 2 ruling in the plan ledger);
            clicking it still does a real navigation/refetch since fetches use cache: 'no-store'. */}
        <a href="/">Retry</a>
      </div>
    );
  }

  const current: CurrentFilters = { chainId, search, status, platform, tab };
  const chainIds = [...new Set(sources.map((source) => source.chainId))];
  const platforms = [...new Set(sources.map((source) => source.platform))];
  // A stale ?tab=trending link (client-side Trending sort was removed — ranking is now
  // server-side via `sort`) must resolve to the All tab, not silently show no active tab.
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : 'all';
  const items = page.items;
  const freshestAsOf = items.map((item) => item.officialVolume24hUsdAsOf).filter((value): value is string => value !== null).sort().at(-1) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {activeTab === 'all' && freshestAsOf !== null && (
        <p className="text-xs text-muted-foreground">Official 24h volume as of {freshestAsOf.replace('T', ' ').slice(0, 16)} UTC</p>
      )}
      <nav aria-label="Filter by tab" className="flex gap-2">
        {TABS.map(({ value, label }) => (
          <a
            key={value}
            href={filterHref(current, { tab: value })}
            aria-current={activeTab === value ? 'page' : undefined}
            className={cn('rounded-md px-3 py-1 text-sm', activeTab === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:underline')}
          >
            {label}
          </a>
        ))}
      </nav>

      <form method="get" role="search" aria-label="Search and filter launches" className="flex flex-wrap gap-2">
        <Input
          type="search"
          name="search"
          defaultValue={search ?? ''}
          placeholder="Search by name or symbol"
          aria-label="Search launches"
          className="max-w-xs"
        />
        <select
          name="status"
          defaultValue={status ?? ''}
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
        {chainId !== undefined && <input type="hidden" name="chainId" value={chainId} />}
        {activeTab !== 'all' && <input type="hidden" name="tab" value={activeTab} />}
        <Button type="submit">Search</Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <LaunchpadFilter platforms={platforms} current={current} selected={platform} />
        <ChainFilter chainIds={chainIds} current={current} selected={chainId} />
      </div>

      <div role="table" aria-label="Launch list" className="w-full overflow-hidden rounded-lg border border-border md:table md:border-separate md:border-spacing-0">
        <div role="rowgroup" className="hidden bg-muted md:table-header-group">
          <div role="row" className="md:table-row">
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:w-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">#</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Token</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Launchpad</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">FDV</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">24H volume</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Liquidity</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">1H %</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">1D %</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Age</div>
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-3 p-3 md:table-row-group md:gap-0 md:p-0">
          {items.map((launch, index) => {
            return (
              <div
                key={`${launch.chainId}-${launch.tokenAddress}`}
                role="row"
                className={cn(
                  'group rounded-lg border border-border bg-card p-3',
                  'md:table-row md:rounded-none md:border-0 md:border-b md:border-border md:bg-transparent md:p-0 md:transition-colors md:hover:bg-muted/60',
                )}
              >
                <div role="cell" className="text-muted-foreground md:table-cell md:p-4 md:align-middle">{index + 1}</div>
                <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                  <TokenCell chainId={launch.chainId} tokenAddress={launch.tokenAddress} name={launch.name}
                    symbol={launch.symbol} logoUri={launch.logoUri} lifecycleStatus={launch.lifecycleStatus} />
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                  <span className="inline-flex items-center gap-2" title={`${launch.platform} ${launch.protocolVersion}`}>
                    <LaunchpadIcon platform={launch.platform} />
                    <span className="capitalize">{launch.platform}</span>
                  </span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">FDV</span>
                  <span className="font-mono">{formatUsd(launch.fdvUsd, 1)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">24H volume</span>
                  <span className="font-mono" title={formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}>
                    {launch.officialVolume24hUsd !== null ? `~${formatUsd(launch.officialVolume24hUsd, 1)}` : formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
                  </span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Liquidity</span>
                  <span className="font-mono" title={tvlTooltip(launch)}>{formatUsd(launch.tvlUsd, 1)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1H %</span>
                  <span className="font-mono"><PercentChange value={launch.change1h} /></span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1D %</span>
                  <span className="font-mono"><PercentChange value={launch.change1d} /></span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Age</span>
                  <span className="text-muted-foreground">{formatAge(launch.launchTimestamp)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {page.nextCursor && (
        <a href={nextPageHref(page.nextCursor, current)} className="underline">
          Next page
        </a>
      )}
    </div>
  );
}
