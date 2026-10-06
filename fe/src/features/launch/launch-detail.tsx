import { chainExplorerBase, chainName } from '@/api/chains';
import { displayName, displaySymbol, formatLifecycleStatus, formatPrice, formatQuote, formatUsd, formatVenueKind, tvlTooltip } from '@/api/format';
import type { CandlePage, LaunchDetail as LaunchDetailData, PoolPage, TransactionPage } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { LaunchpadIcon } from '@/features/launches/launchpad-icon';
import { TokenLogo } from '@/features/launches/token-logo';
import { AboutSection } from './about-section';
import { CoverageBadge } from './coverage-badge';
import { DEFAULT_CHART_INTERVAL, OfficialChart } from './official-chart';
import { TransactionList } from './transaction-list';
import { PoolList } from '@/features/pools/pool-list';

export interface LaunchDetailProps {
  detail: LaunchDetailData;
  transactions: TransactionPage | null;
  candles: CandlePage | null;
  pools?: PoolPage | null;
  chartCurrency?: 'quote' | 'usd';
  chartInterval?: number;
}

export function LaunchDetail({ detail, transactions, candles, pools, chartCurrency = 'quote', chartInterval = DEFAULT_CHART_INTERVAL }: LaunchDetailProps) {
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

  return (
    <article className="flex flex-col gap-4">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain <a> keeps this
          component router-context-free for unit tests, matching launch-list.tsx's retry link. */}
      <a href="/" className="text-sm text-muted-foreground hover:text-primary hover:underline">
        ← Launches
      </a>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <TokenLogo logoUri={detail.logoUri} symbol={displaySymbol(detail.symbol)} chainId={detail.chainId} />
            <h1 className="text-xl font-semibold leading-none">
              {displayName(detail.name, detail.tokenAddress)} <span className="text-muted-foreground">({displaySymbol(detail.symbol)})</span>
            </h1>
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
          <p className="font-mono text-3xl font-semibold">
            Current price: {formatPrice(detail.priceQuote, detail.quoteAsset.symbol)}
            {detail.priceStale && <span className="ml-2 text-sm font-normal text-muted-foreground">(stale price)</span>}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
            <p>Quote asset: {displaySymbol(detail.quoteAsset.symbol)}</p>
            <p className="flex items-center gap-2">
              Lifecycle: {formatLifecycleStatus(detail.lifecycleStatus)} <CoverageBadge status={detail.coverageStatus} />
            </p>
            <p>24h volume: {formatQuote(detail.officialVolume24h, detail.quoteAsset.symbol)}</p>
            <p>FDV: {formatUsd(detail.fdvUsd, 1)}</p>
            <p>Market cap: {formatUsd(detail.marketCapUsd, 1)}</p>
            <p title={tvlTooltip(detail)}>TVL: {formatUsd(detail.tvlUsd, 1)}</p>
            <p>52W High: {formatPrice(detail.week52High, detail.quoteAsset.symbol)}</p>
            <p>52W Low: {formatPrice(detail.week52Low, detail.quoteAsset.symbol)}</p>
          </dl>

          {explorerBase && (
            <a
              href={`${explorerBase}/address/${detail.tokenAddress}`}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-block text-sm underline hover:text-primary"
            >
              View on Blockscout
            </a>
          )}
        </CardContent>
      </Card>

      <section aria-label="About">
        <Card>
          <CardContent className="pt-4">
            <AboutSection
              description={detail.description}
              tokenAddress={detail.tokenAddress}
              explorerUrl={explorerBase ? `${explorerBase}/token/${detail.tokenAddress}` : undefined}
              explorerLabel={explorerBase ? `${chainName(detail.chainId)} Explorer` : undefined}
              websiteUrl={detail.websiteUrl}
              twitterUrl={detail.twitterUrl}
            />
          </CardContent>
        </Card>
      </section>

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

      {candles && (
        <Card>
          <CardContent className="pt-4">
            <OfficialChart
              candles={candles.items}
              graduationTime={graduationTime}
              quoteSymbol={detail.quoteAsset.symbol}
              coverageStatus={chartCoverageStatus}
              currency={chartCurrency}
              intervalSeconds={chartInterval}
            />
          </CardContent>
        </Card>
      )}

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
                  <PoolList page={pools} tokenAddress={detail.tokenAddress} />
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
