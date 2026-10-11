'use client';

import { useState, type ReactNode } from 'react';
import type { PoolCandlePage, PoolSummary } from '@/api/client';
import { displaySymbol, formatPrice, formatUsd } from '@/api/format';
import { PercentChange, RollingText } from '@/components/percent-change';
import type { ChartRangeId } from '@/features/chart/ranges';
import { OfficialChart, type PriceChartStyle, type OfficialChartHoverPoint, type OfficialChartRange } from '@/features/launch/official-chart';
import { rangeChangePercent } from '@/features/launch/official-price-chart';

export function PoolChart({ pool, candles, coverageStatus, quoteSymbol, tokenSymbol, range, onSelectRange, trailing, chartStyle }: {
  pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken' | 'priceInQuote' | 'priceUsd'>;
  candles: PoolCandlePage; coverageStatus: string; quoteSymbol: string; tokenSymbol: string | null;
  range?: ChartRangeId; onSelectRange?: (range: ChartRangeId) => void; trailing?: ReactNode; chartStyle?: PriceChartStyle;
}) {
  const [hover, setHover] = useState<OfficialChartHoverPoint | null>(null);
  const [visibleRange, setVisibleRange] = useState<OfficialChartRange | null>(null);
  // Change across the visible range (to the hovered point while scrubbing); hidden when unavailable.
  const change = visibleRange === null ? null : rangeChangePercent(visibleRange.startClose, hover?.close ?? visibleRange.latestClose);
  return <div>
    {/* priceUsd is the USD price of displayedToken specifically (be/src/pools/stats.ts) and is
        null whenever the quote side lacks a verified USD oracle — which is the normal case once
        "Flip token order" makes the project token the quote. Omitting USD then (rather than
        showing "—") matches Uniswap's own ratio-header convention: USD only accompanies the
        reading where a trusted price is actually known. Hovering swaps the quote amount for the
        pointed-at candle's close (pools have no per-point USD series, so no USD figure is shown
        for that reading either, same "don't fabricate" rule). */}
    <p className="mb-2 text-xl">
      1 {displaySymbol(tokenSymbol)} = <RollingText text={hover === null ? formatPrice(pool.priceInQuote, quoteSymbol) : formatPrice(String(hover.close), quoteSymbol)} value={hover?.close ?? pool.priceInQuote} />
      {hover === null && pool.priceUsd !== null && <span className="text-muted-foreground"> (<RollingText text={formatUsd(pool.priceUsd, 1)} value={pool.priceUsd} />)</span>}
      {change !== null && <span data-testid="pool-price-change" className="ml-2 text-sm"><PercentChange value={change} /></span>}
      {hover !== null && <span className="text-muted-foreground"> · <RollingText text={new Date(hover.time * 1000).toLocaleString('en-US')} /></span>}
    </p>
    <OfficialChart
      candles={candles.items}
      graduationTime={null} quoteSymbol={quoteSymbol} tokenSymbol={tokenSymbol}
      coverageStatus={candles.complete ? coverageStatus : 'backfilling'}
      source={{ pool }} range={range} onSelectRange={onSelectRange} showCurrencyToggle={false} onHoverPoint={setHover} onRangeChange={setVisibleRange} trailing={trailing} chartStyle={chartStyle} />
  </div>;
}
