import { ChevronRight } from '@/components/chevron-right';
import Link from 'next/link';
import { chainExplorerBase, chainName } from '@/api/chains';
import { displayName, displaySymbol, formatPrice, formatUsd, formatUsdCompact, tvlTooltip } from '@/api/format';
import { findActiveVenue, type CandlePage, type LaunchDetail as LaunchDetailData, type PoolHistory, type PoolPage, type PoolSummary, type TransactionPage } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { launchpadName, LaunchpadIcon } from '@/features/launches/launchpad-icon';
import { TokenLogo } from '@/features/launches/token-logo';
import { AboutSection } from './about-section';
import { HeaderActions } from './header-actions';
import { CopyableTokenAddress } from './copyable-token-address';
import { DEFAULT_CHART_INTERVAL } from './official-chart';
import { LaunchChartPanel } from './launch-chart-panel';
import { TransactionList } from './transaction-list';
import { PoolList } from '@/features/pools/pool-list';
import { CurveSwapPanel } from '@/trading/curve-swap-panel';
import type { UsdPrices } from '@/trading/trade-usd';
import { SwapPanel } from '@/trading/swap-panel';
import { V4SwapPanel } from '@/trading/v4-swap-panel';
import { SwapPanelPreview } from '@/trading/swap-panel-preview';
import { StickyDetailHeader } from '@/components/sticky-detail-header';
import { RollingText } from '@/components/percent-change';

export interface LaunchDetailProps {
  detail: LaunchDetailData;
  transactions: TransactionPage | null;
  candles: CandlePage | null;
  pools?: PoolPage | null;
  v4Pool?: PoolSummary | null;
  /** Daily official Volume / TVL series for the chart's Volume and TVL tabs; null hides them. */
  history?: PoolHistory | null;
  chartCurrency?: 'quote' | 'usd';
  chartInterval?: number;
  showSwapPreview?: boolean;
}

export function LaunchDetail({ detail, transactions, candles, pools, v4Pool = null, history = null, chartCurrency = 'quote', chartInterval = DEFAULT_CHART_INTERVAL, showSwapPreview = false }: LaunchDetailProps) {
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
  const ponsPrimaryVenue = detail.platform !== 'pons' ? undefined
    : activeCurveVenue ? {
      kind: 'curve' as const,
      chainId: detail.chainId,
      token: { address: detail.tokenAddress, symbol: displaySymbol(detail.symbol), logoUri: detail.logoUri },
      quoteSymbol: displaySymbol(detail.quoteAsset.symbol),
    }
      : activeV4Venue ? { kind: 'pool' as const, pool: v4Pool, poolId: activeV4Venue.ref, protocol: 'uniswap_v4' }
        : activeV3Venue ? { kind: 'pool' as const, pool: null, poolId: activeV3Venue.ref, protocol: 'uniswap_v3' }
        : null;

  // V4SwapPanel's tokenA/tokenB props are a presentation default (which side starts as "being
  // sold"), independent of zeroForOne — V4SwapPanel derives that itself from address comparison
  // regardless of prop order. Always put the launch's own token on tokenA, like the V3 SwapPanel
  // wiring above already does, instead of letting it depend on which currency happens to sort
  // first in poolKey's real, unmodified order.
  const usdPrices: UsdPrices = {
    [detail.tokenAddress.toLowerCase()]: detail.priceUsd ?? null,
    [detail.quoteAsset.address.toLowerCase()]: detail.quotePriceUsd ?? null,
  };
  const v4LaunchTokenIsCurrency0 = v4Pool ? v4Pool.currency0.toLowerCase() === detail.tokenAddress.toLowerCase() : true;

  return (
    <article className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-base text-muted-foreground">
        <Link href="/launches">Launches</Link>
        <ChevronRight />
        <span className="text-foreground">{displaySymbol(detail.symbol)}</span>
      </nav>

      <StickyDetailHeader>
      <Card className="border-0 bg-background">
        <CardHeader className="border-b border-border px-0 py-4 transition-[padding] duration-200 group-data-[compact=true]:py-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 group-data-[compact=true]:gap-2">
              <TokenLogo logoUri={detail.logoUri} symbol={displaySymbol(detail.symbol)} chainId={detail.chainId} size="detail" />
              <div>
                <h1 className="text-2xl leading-none transition-[font-size] duration-200 group-data-[compact=true]:text-base">
                  {displayName(detail.name, detail.tokenAddress)} <span className="text-lg text-muted-foreground group-data-[compact=true]:hidden">{displaySymbol(detail.symbol)}</span>
                </h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <CopyableTokenAddress address={detail.tokenAddress} copyLabel="Copy header token address" addressClassName="!text-base" />
                  <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                  {detail.platform === 'pons' ? (
                    <a href="https://docs.ponsfamily.com/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1">
                      <LaunchpadIcon platform={detail.platform} />
                      {launchpadName(detail.platform)}
                    </a>
                  ) : <span>{launchpadName(detail.platform)}</span>}
                  <span>· {detail.protocolVersion} · {chainName(detail.chainId)}
                  </span>
                  </p>
                </div>
              </div>
            </div>
            <HeaderActions twitterUrl={detail.twitterUrl} />
          </div>
        </CardHeader>
      </Card>
      </StickyDetailHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-[7.143%]">
        <div className="flex flex-col gap-4">
          <Card className="border-0 bg-transparent">
            <CardContent className="px-0 pt-4">
              <LaunchChartPanel
                chainId={detail.chainId}
                tokenAddress={detail.tokenAddress}
                history={history}
                priceText={priceText}
                priceValue={detail.priceUsd ?? detail.priceQuote}
                priceStale={detail.priceStale}
                candles={candles}
                graduationTime={graduationTime}
                quoteSymbol={detail.quoteAsset.symbol}
                coverageStatus={chartCoverageStatus}
                currency={chartCurrency}
                intervalSeconds={chartInterval}
                tokenSymbol={detail.symbol}
                source={{ launch: { chainId: detail.chainId, tokenAddress: detail.tokenAddress } }}
                showCurrencyToggle={detail.platform !== 'pons'}
              />
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4 lg:max-w-2xl">
            <section aria-label="Stats">
          <h2 className="text-2xl">Stats</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
            <div title={tvlTooltip(detail)}><dt className="text-sm text-muted-foreground">TVL</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatUsdCompact(detail.tvlUsd, 1)} value={detail.tvlUsd} flash /></dd></div>
            <div><dt className="text-sm text-muted-foreground">Market cap</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatUsdCompact(detail.marketCapUsd, 1)} value={detail.marketCapUsd} flash /></dd></div>
            <div><dt className="text-sm text-muted-foreground">FDV</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatUsdCompact(detail.fdvUsd, 1)} value={detail.fdvUsd} flash /></dd></div>
            <div><dt className="text-sm text-muted-foreground">1 day volume</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatUsdCompact(detail.officialVolume24hUsd, 1)} value={detail.officialVolume24hUsd} flash /></dd></div>
            <div><dt className="text-sm text-muted-foreground">52W High</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatPrice(detail.week52High, detail.quoteAsset.symbol)} value={detail.week52High} flash /></dd></div>
            <div><dt className="text-sm text-muted-foreground">52W Low</dt><dd className="mt-0.5 text-2xl"><RollingText text={formatPrice(detail.week52Low, detail.quoteAsset.symbol)} value={detail.week52Low} flash /></dd></div>
              </dl>
            </section>

            <section aria-label="Description">
              <h2 className="text-2xl">Description</h2>
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

        </div>

        {(showSwapPreview || activeCurveVenue || activeV3Venue || activeV4Venue) && (
          <div className="flex flex-col gap-4">
            {showSwapPreview ? (
              <div className="min-w-0 px-px"><SwapPanelPreview
                sellSymbol={displaySymbol(detail.symbol)}
                buySymbol={displaySymbol(detail.quoteAsset.symbol)}
              /></div>
            ) : <>
            {activeCurveVenue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null && (
              <Card className="border-0 bg-transparent">
                <CardContent className="px-px pt-4">
                  <CurveSwapPanel
                    curveAddress={activeCurveVenue.ref as `0x${string}`}
                    tokenAddress={detail.tokenAddress as `0x${string}`}
                    tokenDecimals={detail.tokenDecimals}
                    tokenSymbol={detail.symbol}
                    tokenLogoUri={detail.logoUri}
                    quoteAsset={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals }}
                    explorerBase={explorerBase ?? null}
                    usdPrices={usdPrices}
                  />
                </CardContent>
              </Card>
            )}
            {activeV3Venue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null && (
              <Card className="border-0 bg-transparent">
                <CardContent className="px-px pt-4">
                  <SwapPanel
                    poolAddress={activeV3Venue.ref as `0x${string}`}
                    tokenA={{ address: detail.tokenAddress as `0x${string}`, symbol: displaySymbol(detail.symbol), decimals: detail.tokenDecimals, logoUri: detail.logoUri }}
                    tokenB={{ address: detail.quoteAsset.address as `0x${string}`, symbol: detail.quoteAsset.symbol, decimals: detail.quoteAsset.decimals, logoUri: null }}
                    explorerBase={explorerBase ?? null}
                    usdPrices={usdPrices}
                  />
                </CardContent>
              </Card>
            )}
            {activeV4Venue && v4Pool && v4Pool.currency0Decimals !== null && v4Pool.currency1Decimals !== null && (
              <Card className="border-0 bg-transparent">
                <CardContent className="px-px pt-4">
                  <V4SwapPanel
                    poolKey={{ currency0: v4Pool.currency0 as `0x${string}`, currency1: v4Pool.currency1 as `0x${string}`,
                      fee: v4Pool.fee, tickSpacing: v4Pool.tickSpacing, hooks: v4Pool.hooks as `0x${string}` }}
                    tokenA={v4LaunchTokenIsCurrency0
                      ? { address: v4Pool.currency0 as `0x${string}`, symbol: v4Pool.currency0Symbol, decimals: v4Pool.currency0Decimals, logoUri: detail.logoUri }
                      : { address: v4Pool.currency1 as `0x${string}`, symbol: v4Pool.currency1Symbol, decimals: v4Pool.currency1Decimals, logoUri: detail.logoUri }}
                    tokenB={v4LaunchTokenIsCurrency0
                      ? { address: v4Pool.currency1 as `0x${string}`, symbol: v4Pool.currency1Symbol, decimals: v4Pool.currency1Decimals }
                      : { address: v4Pool.currency0 as `0x${string}`, symbol: v4Pool.currency0Symbol, decimals: v4Pool.currency0Decimals }}
                    explorerBase={explorerBase ?? null}
                    usdPrices={usdPrices}
                  />
                </CardContent>
              </Card>
            )}
            </>}
          </div>
        )}
      </div>

      <Card className="border-0 bg-transparent">
        <CardContent className="px-0 pt-4">
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
                      chainId={detail.chainId}
                      tokenAddress={detail.tokenAddress}
                      nextCursor={transactions.nextCursor}
                    />
                  </>
                ) : (
                  <p role="status">Could not load transactions.</p>
                ),
              },
              {
                value: 'pools',
                label: 'Pools',
                content: (
                      <PoolList page={pools ?? null} error={pools == null} tokenAddress={detail.tokenAddress} chainId={detail.chainId}
                    displayedToken={{ address: detail.tokenAddress, symbol: displaySymbol(detail.symbol), logoUri: detail.logoUri }}
                    primaryVenue={ponsPrimaryVenue} />
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </article>
  );
}
