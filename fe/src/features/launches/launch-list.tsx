import { chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote, formatUsd, tvlTooltip } from '@/api/format';
import { launchHref, type LaunchPage, type Source } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface LaunchListProps {
  page: LaunchPage | null;
  sources: readonly Source[];
  error: boolean;
  chainId?: number;
  search?: string;
  status?: string;
}

const LIFECYCLE_STATUSES = ['trading', 'swept', 'graduated', 'rescued'] as const;

interface CurrentFilters {
  chainId?: number;
  search?: string;
  status?: string;
}

function filterHref(current: CurrentFilters, overrides: CurrentFilters): string {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  if (merged.chainId !== undefined) params.set('chainId', String(merged.chainId));
  if (merged.search) params.set('search', merged.search);
  if (merged.status) params.set('status', merged.status);
  return `/?${params.toString()}`;
}

function nextPageHref(cursor: string, current: CurrentFilters): string {
  const params = new URLSearchParams({ cursor });
  if (current.chainId !== undefined) params.set('chainId', String(current.chainId));
  if (current.search) params.set('search', current.search);
  if (current.status) params.set('status', current.status);
  return `/?${params.toString()}`;
}

export function LaunchList({ page, sources, error, chainId, search, status }: LaunchListProps) {
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

  const current: CurrentFilters = { chainId, search, status };
  const chainIds = [...new Set(sources.map((source) => source.chainId))];

  return (
    <div className="flex flex-col gap-4">
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
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Token</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Launchpad</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Chain</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">
              Quote asset
            </div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">Lifecycle</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">
              Volume 24h
            </div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">
              FDV
            </div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-4 md:text-right md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide">TVL</div>
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-3 p-3 md:table-row-group md:gap-0 md:p-0">
          {page.items.map((launch) => (
            <div
              key={`${launch.chainId}-${launch.tokenAddress}`}
              role="row"
              className={cn(
                'rounded-lg border border-border bg-card p-3',
                'md:table-row md:rounded-none md:border-0 md:border-b md:border-border md:bg-transparent md:p-0 md:transition-colors md:hover:bg-muted/60',
              )}
            >
              <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                <a href={launchHref(launch.chainId, launch.tokenAddress)} className="font-medium text-foreground hover:text-primary hover:underline">
                  {launch.name} <span className="text-muted-foreground">({launch.symbol})</span>
                </a>
              </div>
              <div role="cell" className="md:table-cell md:p-4 md:align-middle">
                {launch.platform} {launch.protocolVersion}
              </div>
              <div role="cell" className="md:table-cell md:p-4 md:align-middle">{chainName(launch.chainId)}</div>
              <div role="cell" className="md:table-cell md:p-4 md:align-middle">{launch.quoteAsset.symbol}</div>
              <div role="cell" className="md:table-cell md:p-4 md:align-middle">{formatLifecycleStatus(launch.lifecycleStatus)}</div>
              <div role="cell" className="font-mono md:table-cell md:p-4 md:text-right md:align-middle">
                {formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
              </div>
              <div role="cell" className="font-mono md:table-cell md:p-4 md:text-right md:align-middle">
                {formatUsd(launch.fdvUsd)}
              </div>
              <div role="cell" title={tvlTooltip(launch)} className="font-mono md:table-cell md:p-4 md:text-right md:align-middle">
                {formatUsd(launch.tvlUsd)}
              </div>
            </div>
          ))}
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
