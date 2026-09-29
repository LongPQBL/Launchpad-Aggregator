import { chainExplorerBase, chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote, formatVenueKind } from '@/api/format';
import type { CandlePage, LaunchDetail as LaunchDetailData, TradePage } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { CoverageBadge } from './coverage-badge';
import { OfficialChart } from './official-chart';
import { TradeList } from './trade-list';

export interface LaunchDetailProps {
  detail: LaunchDetailData;
  trades: TradePage | null;
  candles: CandlePage | null;
}

export function LaunchDetail({ detail, trades, candles }: LaunchDetailProps) {
  const explorerBase = chainExplorerBase(detail.chainId);

  const v4Venue = detail.officialVenues.find((venue) => venue.kind === 'v4_pool');
  // be/src/api/store.ts's listTrades orders newest-first; take the earliest V4 trade in the
  // loaded page (the one closest to the curve→V4 transition), not the first array element.
  const v4TradeTimestamps = v4Venue ? trades?.items.filter((trade) => trade.venueId === v4Venue.id).map((trade) => trade.timestamp) : undefined;
  const graduationTime = v4TradeTimestamps && v4TradeTimestamps.length > 0 ? Math.min(...v4TradeTimestamps) : null;

  const chartCoverageStatus =
    detail.coverageStatus !== 'caught_up' ? detail.coverageStatus : candles && !candles.complete ? 'backfilling' : detail.coverageStatus;

  return (
    <article className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold leading-none">
            {detail.name} ({detail.symbol})
          </h1>
        </CardHeader>
        <CardContent>
          <p>
            Nguồn:{' '}
            <a href="https://docs.ponsfamily.com/" target="_blank" rel="noreferrer noopener" className="underline">
              pons
            </a>{' '}
            · {detail.protocolVersion} · {chainName(detail.chainId)}
          </p>
          <p>Tài sản ghép cặp: {detail.quoteAsset.symbol}</p>
          <p className="flex items-center gap-2">
            Vòng đời: {formatLifecycleStatus(detail.lifecycleStatus)} <CoverageBadge status={detail.coverageStatus} />
          </p>
          <p>
            Giá hiện tại: {formatQuote(detail.priceQuote, detail.quoteAsset.symbol)}
            {detail.priceStale && ' (giá cũ)'}
          </p>
          <p>Volume 24h: {formatQuote(detail.officialVolume24h, detail.quoteAsset.symbol)}</p>
          {explorerBase && (
            <a href={`${explorerBase}/address/${detail.tokenAddress}`} target="_blank" rel="noreferrer noopener" className="underline">
              Xem trên Blockscout
            </a>
          )}
        </CardContent>
      </Card>

      <section aria-label="Nơi giao dịch chính thức">
        <Card>
          <CardContent className="pt-4">
            <ul className="flex flex-col gap-1">
              {detail.officialVenues.map((venue) => (
                <li key={venue.id}>{formatVenueKind(venue.kind)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      {candles && (
        <Card>
          <CardContent className="pt-4">
            <OfficialChart
              candles={candles.items}
              graduationTime={graduationTime}
              quoteSymbol={detail.quoteAsset.symbol}
              coverageStatus={chartCoverageStatus}
            />
          </CardContent>
        </Card>
      )}

      {trades ? (
        <Card>
          <CardContent className="pt-4">
            <TradeList trades={trades.items} venues={detail.officialVenues} quoteSymbol={detail.quoteAsset.symbol} explorerBase={explorerBase} />
          </CardContent>
        </Card>
      ) : (
        <p role="status">Chưa tải được giao dịch.</p>
      )}
    </article>
  );
}
