import { chainExplorerBase, chainName } from '@/api/chains';
import { formatLifecycleStatus, formatQuote, formatVenueKind } from '@/api/format';
import type { CandlePage, LaunchDetail as LaunchDetailData, TradePage } from '@/api/client';
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
    <article>
      <header>
        <h1>
          {detail.name} ({detail.symbol})
        </h1>
        <p>
          Nguồn:{' '}
          <a href="https://docs.ponsfamily.com/" target="_blank" rel="noreferrer noopener">
            pons
          </a>{' '}
          · {detail.protocolVersion} · {chainName(detail.chainId)}
        </p>
        <p>Tài sản ghép cặp: {detail.quoteAsset.symbol}</p>
        <p>
          Vòng đời: {formatLifecycleStatus(detail.lifecycleStatus)} <CoverageBadge status={detail.coverageStatus} />
        </p>
        <p>
          Giá hiện tại: {formatQuote(detail.priceQuote, detail.quoteAsset.symbol)}
          {detail.priceStale && ' (giá cũ)'}
        </p>
        <p>Volume 24h: {formatQuote(detail.officialVolume24h, detail.quoteAsset.symbol)}</p>
        {explorerBase && (
          <a href={`${explorerBase}/address/${detail.tokenAddress}`} target="_blank" rel="noreferrer noopener">
            Xem trên Blockscout
          </a>
        )}
      </header>

      <section aria-label="Nơi giao dịch chính thức">
        <ul>
          {detail.officialVenues.map((venue) => (
            <li key={venue.id}>{formatVenueKind(venue.kind)}</li>
          ))}
        </ul>
      </section>

      {candles && (
        <OfficialChart
          candles={candles.items}
          graduationTime={graduationTime}
          quoteSymbol={detail.quoteAsset.symbol}
          coverageStatus={chartCoverageStatus}
        />
      )}

      {trades ? (
        <TradeList trades={trades.items} venues={detail.officialVenues} quoteSymbol={detail.quoteAsset.symbol} explorerBase={explorerBase} />
      ) : (
        <p role="status">Chưa tải được giao dịch.</p>
      )}
    </article>
  );
}
