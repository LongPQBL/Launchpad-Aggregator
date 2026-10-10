import Link from 'next/link';
import { chainExplorerBase, chainName } from '@/api/chains';
import { displaySymbol, formatPrice, formatQuote } from '@/api/format';
import { poolHref, type CandlePage, type CurveSummary, type LaunchDetail, type PoolHistory, type TransactionPage } from '@/api/client';
import { ChevronRight } from '@/components/chevron-right';
import { StickyDetailHeader } from '@/components/sticky-detail-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { LaunchChartPanel } from '@/features/launch/launch-chart-panel';
import { TransactionList } from '@/features/launch/transaction-list';
import { PoolLogo } from '@/features/pools/pool-logo';
import { poolAge } from '@/features/pools/pool-format';
import { CurveSwapPanel } from '@/trading/curve-swap-panel';
import type { UsdPrices } from '@/trading/trade-usd';

export interface CurveDetailProps {
  detail: LaunchDetail;
  summary: CurveSummary;
  transactions: TransactionPage | null;
  candles: CandlePage | null;
  history: PoolHistory | null;
  chartInterval: number;
}

// A Pons launch's bonding curve on its own, shaped like the pool page: unlike the launch page, whose chart
// and trade list merge the curve with the V4 pool, everything here is scoped to the curve venue.
export function CurveDetail({ detail, summary, transactions, candles, history, chartInterval }: CurveDetailProps) {
  const explorerBase = chainExplorerBase(detail.chainId);
  const tokenSymbol = displaySymbol(detail.symbol);
  const quoteSymbol = displaySymbol(detail.quoteAsset.symbol);
  const pairLabel = `${tokenSymbol} / ${quoteSymbol}`;
  const activeCurveVenue = summary.active
    ? detail.officialVenues.find((venue) => venue.kind === 'curve' && venue.effectiveToBlock === null)
    : undefined;
  const v4Venue = detail.officialVenues.find((venue) => venue.kind === 'v4_pool');
  const chartCoverageStatus =
    detail.coverageStatus !== 'caught_up' ? detail.coverageStatus : candles && !candles.complete ? 'backfilling' : detail.coverageStatus;
  const usdPrices: UsdPrices = {
    [detail.tokenAddress.toLowerCase()]: detail.priceUsd ?? null,
    [detail.quoteAsset.address.toLowerCase()]: detail.quotePriceUsd ?? null,
  };
  const launchedAt = detail.launchTimestamp === null ? null : Number(detail.launchTimestamp);

  return (
    <article className="space-y-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-base text-muted-foreground">
        <Link href="/pools">Pools</Link>
        <ChevronRight />
        <span className="text-foreground">{pairLabel}</span>
      </nav>

      <StickyDetailHeader>
        <Card className="border-0 bg-background">
          <CardHeader className="flex-row items-center gap-3 px-0 py-4 transition-[padding] duration-200 group-data-[compact=true]:gap-2 group-data-[compact=true]:py-2">
            <PoolLogo
              size="detail"
              token0={{ symbol: tokenSymbol, logoUri: detail.logoUri }}
              token1={{ symbol: quoteSymbol, logoUri: null }}
              chainId={detail.chainId}
            />
            <div>
              <h1 className="text-2xl transition-[font-size] duration-200 group-data-[compact=true]:text-base">{pairLabel}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                <span>{chainName(detail.chainId)}</span>
                <Badge variant="secondary">Bonding curve</Badge>
                <span>Official Pons pool</span>
              </div>
            </div>
          </CardHeader>
        </Card>
      </StickyDetailHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-[7.143%]">
        <div className="flex flex-col gap-4">
          <LaunchChartPanel
            chainId={detail.chainId}
            tokenAddress={detail.tokenAddress}
            history={history}
            venue="curve"
            priceText={summary.lastPriceQuote === null ? '—' : formatPrice(summary.lastPriceQuote, quoteSymbol)}
            priceStale={false}
            candles={candles}
            graduationTime={null}
            quoteSymbol={quoteSymbol}
            coverageStatus={chartCoverageStatus}
            currency="quote"
            intervalSeconds={chartInterval}
            tokenSymbol={detail.symbol}
            source={{ launch: { chainId: detail.chainId, tokenAddress: detail.tokenAddress, venue: 'curve' } }}
            showCurrencyToggle={false}
          />

          <section aria-labelledby="curve-transactions-heading" className="space-y-3">
            <h2 id="curve-transactions-heading" className="text-2xl">Transactions</h2>
            {transactions === null ? <p role="status">Could not load transactions.</p>
              : transactions.items.length === 0 ? <p>No transactions yet</p>
                : <TransactionList
                  transactions={transactions.items}
                  venues={detail.officialVenues}
                  tokenSymbol={detail.symbol}
                  quoteAsset={detail.quoteAsset}
                  explorerBase={explorerBase}
                  chainId={detail.chainId}
                  tokenAddress={detail.tokenAddress}
                  nextCursor={transactions.nextCursor}
                  venue="curve"
                />}
          </section>
        </div>

        <div className="flex flex-col gap-4">
          {activeCurveVenue && detail.tokenDecimals !== null && detail.quoteAsset.decimals !== null ? (
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
          ) : !summary.active ? (
            <p className="text-sm text-muted-foreground">
              This launch has left its bonding curve and trades on Uniswap.
              {v4Venue && <> <Link className="text-brand-text" href={poolHref({ chainId: detail.chainId, protocol: 'uniswap_v4', poolId: v4Venue.ref }, detail.tokenAddress)}>Open the official V4 pool</Link></>}
            </p>
          ) : null}

          <Card className="rounded-[20px] border-0 bg-muted">
            <section aria-label="Stats">
              <CardHeader className="p-5 pb-0"><h2 className="text-2xl">Stats</h2></CardHeader>
              <CardContent className="mt-6 grid gap-x-4 gap-y-5 p-5 pt-0 sm:grid-cols-2">
                <dl className="contents">
                  <div><dt className="text-sm text-muted-foreground">24H volume</dt><dd className="text-lg">{formatQuote(summary.volume24hQuote, quoteSymbol)}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">24H trades</dt><dd className="text-lg">{summary.tradeCount24h}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">Current price</dt><dd className="text-lg">{summary.lastPriceQuote === null ? '—' : formatPrice(summary.lastPriceQuote, quoteSymbol)}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">Age</dt><dd className="text-lg">{poolAge(launchedAt)}</dd></div>
                </dl>
              </CardContent>
            </section>
          </Card>
        </div>
      </div>
    </article>
  );
}
