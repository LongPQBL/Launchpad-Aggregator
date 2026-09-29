import { chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote } from '@/api/format';
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
        <p>Không tải được danh sách launch từ máy chủ. Vui lòng thử lại.</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain <a> keeps this
            component router-context-free for unit tests (see Task 2 ruling in the plan ledger);
            clicking it still does a real navigation/refetch since fetches use cache: 'no-store'. */}
        <a href="/">Thử lại</a>
      </div>
    );
  }

  const current: CurrentFilters = { chainId, search, status };
  const chainIds = [...new Set(sources.map((source) => source.chainId))];

  return (
    <div className="flex flex-col gap-4">
      <form method="get" role="search" aria-label="Tìm và lọc launch" className="flex flex-wrap gap-2">
        <Input
          type="search"
          name="search"
          defaultValue={search ?? ''}
          placeholder="Tìm theo tên hoặc symbol"
          aria-label="Tìm launch"
          className="max-w-xs"
        />
        <select
          name="status"
          defaultValue={status ?? ''}
          aria-label="Lọc theo vòng đời"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">Tất cả trạng thái</option>
          {LIFECYCLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {formatLifecycleStatus(value)}
            </option>
          ))}
        </select>
        {chainId !== undefined && <input type="hidden" name="chainId" value={chainId} />}
        <Button type="submit">Tìm</Button>
      </form>

      {chainIds.length > 1 && (
        <nav aria-label="Lọc theo chain" className="flex gap-2">
          {chainIds.map((id) => (
            <a key={id} href={filterHref(current, { chainId: id })} className="underline">
              Chain {id}
            </a>
          ))}
        </nav>
      )}

      <div role="table" aria-label="Danh sách launch" className="w-full md:table">
        <div role="rowgroup" className="hidden md:table-header-group">
          <div role="row" className="md:table-row">
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">Token</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">Sàn</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">Chain</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">
              Tài sản ghép cặp
            </div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">Vòng đời</div>
            <div role="columnheader" className="text-muted-foreground md:table-cell md:h-10 md:px-2 md:align-middle md:font-medium">
              Volume 24h
            </div>
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-3 md:table-row-group">
          {page.items.map((launch) => (
            <div
              key={`${launch.chainId}-${launch.tokenAddress}`}
              role="row"
              className={cn(
                'rounded-lg border border-border bg-card p-3',
                'md:table-row md:rounded-none md:border-0 md:border-b md:bg-transparent md:p-0',
              )}
            >
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">
                <a href={launchHref(launch.chainId, launch.tokenAddress)} className="underline">
                  {launch.name} ({launch.symbol})
                </a>
              </div>
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">
                {launch.platform} {launch.protocolVersion}
              </div>
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">{chainName(launch.chainId)}</div>
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">{launch.quoteAsset.symbol}</div>
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">{formatLifecycleStatus(launch.lifecycleStatus)}</div>
              <div role="cell" className="md:table-cell md:p-2 md:align-middle">
                {formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {page.nextCursor && (
        <a href={nextPageHref(page.nextCursor, current)} className="underline">
          Trang sau
        </a>
      )}
    </div>
  );
}
