'use client';

import { useCallback, type ComponentProps } from 'react';
import { getLaunchHistory, type PoolHistory } from '@/api/client';
import { DEFAULT_CHART_RANGE, type ChartRangeId } from '@/features/chart/ranges';
import { ChartTypePanel } from '@/features/pools/pool-chart-panel';
import { CurveDepthChart } from '@/features/pools/pool-liquidity';
import { displaySymbol } from '@/api/format';
import { OfficialPriceChart } from './official-price-chart';

// The launch page's chart area: the price chart plus Volume and TVL over the token's pools for one shared time range
// (scoped to the bonding curve, Volume is the curve's alone).
export function LaunchChartPanel({ chainId, tokenAddress, history, venue, initialRange = DEFAULT_CHART_RANGE, ...price }: Omit<ComponentProps<typeof OfficialPriceChart>, 'trailing' | 'range' | 'onSelectRange' | 'chartStyle'> & {
  chainId: number; tokenAddress: string; history: PoolHistory | null;
  /** The range the server rendered `history` and `candles` for (from the page URL). */
  initialRange?: ChartRangeId;
  /** Scope the Volume series to one venue (the bonding curve). A scoped panel has no TVL tab: TVL belongs to the V4 pool. */
  venue?: 'curve';
}) {
  const loadHistory = useCallback((range: ChartRangeId) => getLaunchHistory(chainId, tokenAddress, range, venue), [chainId, tokenAddress, venue]);
  // The bonding curve (a constant-product curve with a fee) also has a Depth view; a token's many pools have none.
  const extra = venue === 'curve' ? { depth: ({ tabs }: { tabs: React.ReactNode }) => (
    <CurveDepthChart chainId={chainId} tokenAddress={tokenAddress} baseSymbol={displaySymbol(price.tokenSymbol ?? null)} quoteSymbol={displaySymbol(price.quoteSymbol)} trailing={tabs} />) } : undefined;
  return <ChartTypePanel loadHistory={loadHistory} history={history} initialRange={initialRange} showTvl={venue === undefined} allPools={venue === undefined} extra={extra} headerClassName="min-h-8 text-2xl"
    price={({ tabs, range, onSelectRange, chartStyle }) => <OfficialPriceChart {...price} range={range} onSelectRange={onSelectRange} trailing={tabs} chartStyle={chartStyle} />} />;
}
