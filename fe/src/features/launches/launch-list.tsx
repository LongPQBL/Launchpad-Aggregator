import { chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote } from '@/api/format';
import { launchHref, type LaunchPage, type Source } from '@/api/client';

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
    <div>
      <form method="get" role="search" aria-label="Tìm và lọc launch" className="mb-4 flex flex-wrap gap-2">
        <input
          type="search"
          name="search"
          defaultValue={search ?? ''}
          placeholder="Tìm theo tên hoặc symbol"
          aria-label="Tìm launch"
        />
        <select name="status" defaultValue={status ?? ''} aria-label="Lọc theo vòng đời">
          <option value="">Tất cả trạng thái</option>
          {LIFECYCLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {formatLifecycleStatus(value)}
            </option>
          ))}
        </select>
        {chainId !== undefined && <input type="hidden" name="chainId" value={chainId} />}
        <button type="submit">Tìm</button>
      </form>

      {chainIds.length > 1 && (
        <nav aria-label="Lọc theo chain">
          {chainIds.map((id) => (
            <a key={id} href={filterHref(current, { chainId: id })}>
              Chain {id}
            </a>
          ))}
        </nav>
      )}

      <div role="table" aria-label="Danh sách launch" className="w-full md:table">
        <div role="rowgroup" className="hidden md:table-header-group">
          <div role="row" className="md:table-row">
            <div role="columnheader" className="md:table-cell">Token</div>
            <div role="columnheader" className="md:table-cell">Sàn</div>
            <div role="columnheader" className="md:table-cell">Chain</div>
            <div role="columnheader" className="md:table-cell">Tài sản ghép cặp</div>
            <div role="columnheader" className="md:table-cell">Vòng đời</div>
            <div role="columnheader" className="md:table-cell">Volume 24h</div>
          </div>
        </div>
        <div role="rowgroup" className="flex flex-col gap-3 md:table-row-group">
          {page.items.map((launch) => (
            <div
              key={`${launch.chainId}-${launch.tokenAddress}`}
              role="row"
              className="rounded border border-border p-3 md:table-row md:border-0 md:p-0"
            >
              <div role="cell" className="md:table-cell">
                <a href={launchHref(launch.chainId, launch.tokenAddress)}>
                  {launch.name} ({launch.symbol})
                </a>
              </div>
              <div role="cell" className="md:table-cell">
                {launch.platform} {launch.protocolVersion}
              </div>
              <div role="cell" className="md:table-cell">{chainName(launch.chainId)}</div>
              <div role="cell" className="md:table-cell">{launch.quoteAsset.symbol}</div>
              <div role="cell" className="md:table-cell">{formatLifecycleStatus(launch.lifecycleStatus)}</div>
              <div role="cell" className="md:table-cell">
                {formatQuote(launch.officialVolume24h, launch.quoteAsset.symbol)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {page.nextCursor && <a href={nextPageHref(page.nextCursor, current)}>Trang sau</a>}
    </div>
  );
}
