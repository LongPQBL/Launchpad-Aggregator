import { chainExplorerBase, chainName } from '@/api/chains';
import { displayName, displaySymbol, formatLifecycleStatus, formatPrice, formatQuote, formatUsd, formatVenueKind, tvlTooltip } from '@/api/format';
import { findActiveVenue, type CandlePage, type LaunchDetail as LaunchDetailData, type PoolPage, type PoolSummary, type TransactionPage } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { LaunchpadIcon } from '@/features/launches/launchpad-icon';
import { TokenLogo } from '@/features/launches/token-logo';
import { AboutSection } from './about-section';
import { CoverageBadge } from './coverage-badge';
import { DEFAULT_CHART_INTERVAL, OfficialChart } from './official-chart';
import { TransactionList } from './transaction-list';
import { PoolList } from '@/features/pools/pool-list';
import { CurveTradePanel } from '@/trading/curve-trade-panel';
import { SwapPanel } from '@/trading/swap-panel';
import { V4SwapPanel } from '@/trading/v4-swap-panel';

export interface LaunchDetailProps {
  detail: LaunchDetailData;
  transactions: TransactionPage | null;
  candles: CandlePage | null;
  pools?: PoolPage | null;
  v4Pool?: PoolSummary | null;
  chartCurrency?: 'quote' | 'usd';
  chartInterval?: number;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function LaunchDetail({ detail, transactions, candles, pools, v4Pool = null, chartCurrency = 'quote', chartInterval = DEFAULT_CHART_INTERVAL }: LaunchDetailProps) {
  const explorerBase = chainExplorerBase(detail.chainId);

  const v4Venue = detail.officialVenues.find((venue) => venue.kind === 'v4_pool');
  // be/src/api/store.ts's listTransactions orders newest-first; take the earliest V4 trade in the
  // loaded page (the one closest to the curve→V4 transition), not the first array element.
  const v4TradeTimestamps = v4Venue
    ? transactions?.items.filter((row) => row.source === 'official' && row.venueId === v4Venue.id).map((row) => row.timestamp)
    : undefined;
  const graduationTime = v4TradeTimestamps && v4TradeTimestamps.length > 0 ? Math.min(...v4TradeTimestamps) : null;

  const chartCoverageStatus =
    detail.coverageStatus !== 'caught_up' ? detail.coverageStatus : candles && !candles.complete ? 'backfilling' : detail.coverageStatus;

  // The USD price is the headline figure (matches the reference design); a launch whose USD oracle
  // isn't resolved yet falls back to the quote-denominated price rather than showing nothing.
  const priceText = detail.priceUsd !== null ? formatUsd(detail.priceUsd, 2)
    : detail.priceQuote !== null ? formatPrice(detail.priceQuote, detail.quoteAsset.symbol) : '—';

  const activeCurveVenue = detail.lifecycleStatus === 'trading'
    ? detail.officialVenues.find((venue) => venue.kind === 'curve' && venue.effectiveToBlock === null)
    : undefined;

  // Unlike the curve gate above, this deliberately has no `lifecycleStatus` condition: a V1 launch's
  // V3 pool is its venue from launch with no curve-to-pool transition to distinguish — every
  // lifecycleStatus a V1 launch can have ('trading' or 'graduated') maps to exactly one active
  // v3_pool venue.
  const activeV3Venue = detail.officialVenues.find((venue) => venue.kind === 'v3_pool' && venue.effectiveToBlock === null);

  // Mirrors activeV3Venue's reasoning: a V2 launch's V4 pool venue has no curve-to-pool lifecycle
  // condition to add beyond effectiveToBlock — the curve-vs-V4 distinction already lives in
  // activeCurveVenue's own lifecycleStatus === 'trading' gate above.
  const activeV4Venue = findActiveVenue(detail.officialVenues, 'v4_pool');

  // V4SwapPanel's tokenA/tokenB props are a presentation default (which side starts as "being
  // sold"), independent of zeroForOne — V4SwapPanel derives that itself from address comparison
  // regardless of prop order. Always put the launch's own token on tokenA, like the V3 SwapPanel
  // wiring above already does, instead of letting it depend on which currency happens to sort
  // first in poolKey's real, unmodified order.
  const v4LaunchTokenIsCurrency0 = v4Pool ? v4Pool.currency0.toLowerCase() === detail.tokenAddress.toLowerCase() : true;

  return (
    <article className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain <a> keeps this
            component router-context-free for unit tests, matching launch-list.tsx's retry link. */}
        <a href="/" className="hover:text-primary hover:underline">Launches</a>
        <span aria-hidden="true">›</span>
        <span className="font-medium text-foreground">{displaySymbol(detail.symbol)}</span>
      </nav>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <TokenLogo logoUri={detail.logoUri} symbol={displaySymbol(detail.symbol)} chainId={detail.chainId} />
            <div>
              <h1 className="text-xl font-semibold leading-none">
                {displayName(detail.name, detail.tokenAddress)} <span className="text-muted-foreground">({displaySymbol(detail.symbol)})</span>
              </h1>
              <p data-testid="header-token-address" className="mt-1 font-mono text-xs text-muted-foreground">
                {shortAddress(detail.tokenAddress)}
              </p>
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <span>Source:</span>
            {detail.platform === 'pons' ? (
              <a href="https://docs.ponsfamily.com/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline hover:text-primary">
                <LaunchpadIcon platform={detail.platform} />
                {detail.platform}
              </a>
            ) : <span>{detail.platform}</span>}
            <span>· {detail.protocolVersion} · {chainName(detail.chainId)}</span>
          </p>
        </CardHeader>
        <CardContent>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
            <p>Quote asset: {displaySymbol(detail.quoteAsset.symbol)}</p>
            <p className="flex items-center gap-2">
              Lifecycle: {formatLifecycleStatus(detail.lifecycleStatus)} <CoverageBadge status={detail.coverageStatus} />
            </p>
            <p>24h volume: {formatQuote(detail.officialVolume24h, detail.quoteAsset.symbol)}</p>
          </dl>
        </CardContent>
      </Card>

      <section aria-label="Official trading venues">
        <Card>
          <CardContent className="pt-4">
            <ul className="flex flex-wrap gap-2">
              {detail.officialVenues.map((venue) => (
                <li key={venue.id} className="rounded-md bg-accent px-2 py-1 text-sm text-accent-foreground">
                  {formatVenueKind(venue.kind)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardContent className="pt-4">
          <p data-testid="official-price" className="mb-2 text-3xl font-semibold">
            {priceText}
            {detail.priceStale && <span className="ml-2 text-sm font-normal text-muted-foreground">(stale price)</span>}
          </p>
          {activeCurveVenue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null && (
            <div className="mt-4 border-t border-border pt-4">
              <CurveTradePanel
                curveAddress={activeCurveVenue.ref as `0x${string}`}
                tokenAddress={detail.tokenAddress as `0x${string}`}
                tokenDecimals={detail.tokenDecimals}
                quoteAsset={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals }}
                explorerBase={explorerBase ?? null}
              />
            </div>
          )}
          {activeV3Venue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null && (
            <div className="mt-4 border-t border-border pt-4">
              <SwapPanel
                poolAddress={activeV3Venue.ref as `0x${string}`}
                tokenA={{ address: detail.tokenAddress as `0x${string}`, symbol: displaySymbol(detail.symbol), decimals: detail.tokenDecimals }}
                tokenB={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals }}
                explorerBase={explorerBase ?? null}
              />
            </div>
          )}
          {activeV4Venue && v4Pool && v4Pool.currency0Decimals !== null && v4Pool.currency1Decimals !== null && (
            <div className="mt-4 border-t border-border pt-4">
              <V4SwapPanel
                poolKey={{ currency0: v4Pool.currency0 as `0x${string}`, currency1: v4Pool.currency1 as `0x${string}`,
                  fee: v4Pool.fee, tickSpacing: v4Pool.tickSpacing, hooks: v4Pool.hooks as `0x${string}` }}
                tokenA={v4LaunchTokenIsCurrency0
                  ? { address: v4Pool.currency0 as `0x${string}`, symbol: v4Pool.currency0Symbol, decimals: v4Pool.currency0Decimals }
                  : { address: v4Pool.currency1 as `0x${string}`, symbol: v4Pool.currency1Symbol, decimals: v4Pool.currency1Decimals }}
                tokenB={v4LaunchTokenIsCurrency0
                  ? { address: v4Pool.currency1 as `0x${string}`, symbol: v4Pool.currency1Symbol, decimals: v4Pool.currency1Decimals }
                  : { address: v4Pool.currency0 as `0x${string}`, symbol: v4Pool.currency0Symbol, decimals: v4Pool.currency0Decimals }}
                explorerBase={explorerBase ?? null}
              />
            </div>
          )}
          {candles && (
            <OfficialChart
              candles={candles.items}
              graduationTime={graduationTime}
              quoteSymbol={detail.quoteAsset.symbol}
              coverageStatus={chartCoverageStatus}
              currency={chartCurrency}
              intervalSeconds={chartInterval}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 lg:max-w-2xl">
        <section aria-label="Stats">
          <h2 className="text-lg font-semibold">Stats</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <p title={tvlTooltip(detail)}>TVL: {formatUsd(detail.tvlUsd, 1)}</p>
            <p>Market cap: {formatUsd(detail.marketCapUsd, 1)}</p>
            <p>FDV: {formatUsd(detail.fdvUsd, 1)}</p>
            <p>1 day volume: {formatUsd(detail.officialVolume24hUsd, 1)}</p>
            <p>52W High: {formatPrice(detail.week52High, detail.quoteAsset.symbol)}</p>
            <p>52W Low: {formatPrice(detail.week52Low, detail.quoteAsset.symbol)}</p>
          </dl>
        </section>

        <section aria-label="Description">
          <h2 className="text-lg font-semibold">Description</h2>
          <div className="mt-3">
            <AboutSection
              description={detail.description}
              tokenAddress={detail.tokenAddress}
              explorerUrl={explorerBase ? `${explorerBase}/token/${detail.tokenAddress}` : undefined}
              explorerLabel={explorerBase ? `${chainName(detail.chainId)} Explorer` : undefined}
              websiteUrl={detail.websiteUrl}
              twitterUrl={detail.twitterUrl}
            />
          </div>
        </section>
      </div>

      <Card>
        <CardContent className="pt-4">
          <Tabs
            tabs={[
              {
                value: 'transactions',
                label: 'Transactions',
                content: transactions ? (
                  <>
                    <TransactionList
                      transactions={transactions.items}
                      venues={detail.officialVenues}
                      tokenSymbol={detail.symbol}
                      quoteAsset={detail.quoteAsset}
                      explorerBase={explorerBase}
                    />
                    {transactions.nextCursor && (
                      <a
                        className="mt-3 block underline"
                        href={`/launches/${detail.chainId}/${detail.tokenAddress}?cursor=${encodeURIComponent(transactions.nextCursor)}`}
                      >
                        Next transactions
                      </a>
                    )}
                  </>
                ) : (
                  <p role="status">Could not load transactions.</p>
                ),
              },
              {
                value: 'pools',
                label: 'Pools',
                content: pools ? (
                  <PoolList page={pools} tokenAddress={detail.tokenAddress}
                    displayedToken={{ address: detail.tokenAddress, symbol: displaySymbol(detail.symbol), logoUri: detail.logoUri }} />
                ) : (
                  <p role="status">Could not load pools.</p>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </article>
  );
}
