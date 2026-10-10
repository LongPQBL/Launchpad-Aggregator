'use client';

import { useState, type ReactNode } from 'react';
import type { CandlePage } from '@/api/client';
import { formatPrice, formatUsd } from '@/api/format';
import { PercentChange, RollingText } from '@/components/percent-change';
import { OfficialChart, type OfficialChartHoverPoint, type OfficialChartRange, type OfficialChartSource } from './official-chart';

// Uniswap-style: change from the first point of the visible range to the latest price, or to the
// hovered point while scrubbing. Null (shown as "—") when either end isn't a usable positive price.
export function rangeChangePercent(startClose: number, endClose: number): string | null {
  if (!Number.isFinite(startClose) || !Number.isFinite(endClose) || startClose <= 0) return null;
  return String(((endClose - startClose) / startClose) * 100);
}

// Owns the hover state so the headline price (Uniswap-style: the big number itself tracks the
// cursor, not a separate OHLC readout) and the chart stay in sync. A plain server component
// can't hold this state itself, hence this dedicated client wrapper around the two.
export function OfficialPriceChart({
  priceText,
  priceValue,
  priceStale,
  candles,
  graduationTime,
  quoteSymbol,
  coverageStatus,
  currency,
  intervalSeconds,
  tokenSymbol,
  source,
  showCurrencyToggle = true,
  trailing,
}: {
  priceText: string;
  priceValue?: string | null;
  priceStale: boolean;
  candles: CandlePage | null;
  graduationTime: number | null;
  quoteSymbol: string | null;
  coverageStatus: string;
  currency: 'quote' | 'usd';
  intervalSeconds: number;
  tokenSymbol: string | null;
  source: OfficialChartSource;
  showCurrencyToggle?: boolean;
  /** Right side of the interval row (the Price / Volume / TVL switcher). */
  trailing?: ReactNode;
}) {
  const [hover, setHover] = useState<OfficialChartHoverPoint | null>(null);
  const [range, setRange] = useState<OfficialChartRange | null>(null);
  const change = range === null ? null : rangeChangePercent(range.startClose, hover?.close ?? range.latestClose);
  const hoverText = hover === null
    ? null
    : hover.currency === 'usd' ? formatUsd(String(hover.close), 2) : formatPrice(String(hover.close), quoteSymbol);

  return (
    <div>
      <p data-testid="official-price" className="mb-2 text-2xl">
        <RollingText text={hoverText ?? priceText} value={hover?.close ?? priceValue} />
        {hover === null && priceStale && <span className="ml-2 text-xs text-muted-foreground">(stale price)</span>}
        {change !== null && <span data-testid="official-price-change" className="ml-2 text-sm"><PercentChange value={change} /></span>}
        {hover !== null && <span className="ml-2 text-xs text-muted-foreground"><RollingText text={new Date(hover.time * 1000).toLocaleString('en-US')} /></span>}
      </p>
      {candles && (
        <OfficialChart
          candles={candles.items}
          graduationTime={graduationTime}
          quoteSymbol={quoteSymbol}
          coverageStatus={coverageStatus}
          currency={currency}
          intervalSeconds={intervalSeconds}
          tokenSymbol={tokenSymbol}
          source={source}
          showCurrencyToggle={showCurrencyToggle}
          onHoverPoint={setHover}
          onRangeChange={setRange}
          trailing={trailing}
        />
      )}
    </div>
  );
}
