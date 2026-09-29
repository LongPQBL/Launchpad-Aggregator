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

// Only chain known/verified in be/src/chains today (README, be/src/chains/robinhood.ts).
// A chain-registry that scales beyond this hardcode is a Roadmap-2 concern, not this task's.
const CHAIN_NAMES: Record<number, string> = { 4663: 'Robinhood Chain' };
const CHAIN_EXPLORERS: Record<number, string> = { 4663: 'https://robinhoodchain.blockscout.com' };

export function LaunchDetail({ detail, trades, candles }: LaunchDetailProps) {
  const chainName = CHAIN_NAMES[detail.chainId] ?? `Chain ${detail.chainId}`;
  const explorerBase = CHAIN_EXPLORERS[detail.chainId];

  const v4Venue = detail.officialVenues.find((venue) => venue.kind === 'v4_pool');
  const graduationTime = v4Venue ? (trades?.items.find((trade) => trade.venueId === v4Venue.id)?.timestamp ?? null) : null;

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
          · {detail.protocolVersion} · {chainName}
        </p>
        <p>Tài sản ghép cặp: {detail.quoteAsset.symbol}</p>
        <p>
          Vòng đời: {formatLifecycleStatus(detail.lifecycleStatus)} <CoverageBadge status={detail.coverageStatus} />
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
