import { chainName } from '@/api/chains';
import { displayName, displaySymbol, formatLifecycleStatus, formatQuote, formatUsd, tvlTooltip } from '@/api/format';
import { launchHref, type LaunchPage, type Source } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { LaunchpadIcon } from './launchpad-icon';
import { TokenLogo } from './token-logo';

export interface LaunchListProps {
  page: LaunchPage | null;
  sources: readonly Source[];
  error: boolean;
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

function formatPercentChange(value: string | null): { text: string; className: string } {
  if (value === null) return { text: '—', className: 'text-muted-foreground' };
  const numeric = Number(value);
  if (numeric > 0) return { text: `+${value}%`, className: 'text-emerald-600' };
  if (numeric < 0) return { text: `${value}%`, className: 'text-red-600' };
  return { text: `${value}%`, className: 'text-muted-foreground' };
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

export function LaunchList({ page, sources, error, chainId, search, status, platform, tab }: LaunchListProps) {
  if (error || !page) {
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

  return (
    <div className="flex flex-col gap-4">
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
        <select
          name="platform"
          defaultValue={platform ?? ''}
          aria-label="Filter by launchpad"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All launchpads</option>
          {platforms.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {chainId !== undefined && <input type="hidden" name="chainId" value={chainId} />}
        {activeTab !== 'all' && <input type="hidden" name="tab" value={activeTab} />}
        <Button type="submit">Search</Button>
      </form>

      {chainIds.length > 1 && (
        <nav aria-label="Filter by chain" className="flex gap-2">
          {chainIds.map((id) => (
            <a key={id} href={filterHref(current, { chainId: id })} className="underline">
              Chain {id}
            </a>
          ))}
        </nav>
      )}

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
            const change1h = formatPercentChange(launch.change1h);
            const change1d = formatPercentChange(launch.change1d);
            return (
              <div
                key={`${launch.chainId}-${launch.tokenAddress}`}
                role="row"
                className={cn(
                  'rounded-lg border border-border bg-card p-3',
                  'md:table-row md:rounded-none md:border-0 md:border-b md:border-border md:bg-transparent md:p-0 md:transition-colors md:hover:bg-muted/60',
                )}
              >
                <div role="cell" className="text-muted-foreground md:table-cell md:p-4 md:align-middle">{index + 1}</div>
                <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                  <div className="flex items-center gap-3">
                    <TokenLogo logoUri={launch.logoUri} symbol={displaySymbol(launch.symbol)} chainId={launch.chainId} />
                    <div className="flex flex-col">
                      <a href={launchHref(launch.chainId, launch.tokenAddress)} className="font-medium text-foreground hover:text-primary hover:underline">
                        {displayName(launch.name, launch.tokenAddress)} <span className="text-muted-foreground">({displaySymbol(launch.symbol)})</span>
                      </a>
                      <span className="text-xs text-muted-foreground">
                        <span>{chainName(launch.chainId)}</span> · <span>{formatLifecycleStatus(launch.lifecycleStatus)}</span>
                      </span>
                    </div>
                  </div>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                  <span className="inline-flex items-center gap-1">
                    <LaunchpadIcon platform={launch.platform} />
                    <span>{launch.platform} {launch.protocolVersion}</span>
                  </span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">FDV</span>
                  <span className="font-mono">{formatUsd(launch.fdvUsd)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">24H volume</span>
                  <span className="font-mono" title={formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}>
                    {launch.officialVolume24hUsd !== null ? `~${formatUsd(launch.officialVolume24hUsd)}` : formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
                  </span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Liquidity</span>
                  <span className="font-mono" title={tvlTooltip(launch)}>{formatUsd(launch.tvlUsd)}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1H %</span>
                  <span className={cn('font-mono', change1h.className)}>{change1h.text}</span>
                </div>
                <div role="cell" className="md:table-cell md:p-4 md:text-right md:align-middle">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">1D %</span>
                  <span className={cn('font-mono', change1d.className)}>{change1d.text}</span>
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
