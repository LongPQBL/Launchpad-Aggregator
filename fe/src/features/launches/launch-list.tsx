import { chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote } from '@/api/format';
import { launchHref, type LaunchPage, type Source } from '@/api/client';

export interface LaunchListProps {
  page: LaunchPage | null;
  sources: readonly Source[];
  error: boolean;
  chainId?: number;
}

function nextPageHref(cursor: string, chainId?: number): string {
  const params = new URLSearchParams({ cursor });
  if (chainId !== undefined) params.set('chainId', String(chainId));
  return `/?${params.toString()}`;
}

export function LaunchList({ page, sources, error, chainId }: LaunchListProps) {
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

  const chainIds = [...new Set(sources.map((source) => source.chainId))];

  return (
    <div>
      {chainIds.length > 1 && (
        <nav aria-label="Lọc theo chain">
          {chainIds.map((id) => (
            <a key={id} href={`/?chainId=${id}`}>
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

      {page.nextCursor && <a href={nextPageHref(page.nextCursor, chainId)}>Trang sau</a>}
    </div>
  );
}
