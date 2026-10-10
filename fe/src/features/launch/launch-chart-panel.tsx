'use client';

import { useCallback, type ComponentProps } from 'react';
import { getLaunchHistory, type PoolHistory } from '@/api/client';
import { DEFAULT_CHART_RANGE, type ChartRangeId } from '@/features/chart/ranges';
import { ChartTypePanel } from '@/features/pools/pool-chart-panel';
import { OfficialPriceChart } from './official-price-chart';

// The launch page's chart area: the price chart plus the launch's official Volume and TVL charts for one shared time range.
export function LaunchChartPanel({ chainId, tokenAddress, history, venue, initialRange = DEFAULT_CHART_RANGE, ...price }: Omit<ComponentProps<typeof OfficialPriceChart>, 'trailing' | 'range' | 'onSelectRange'> & {
  chainId: number; tokenAddress: string; history: PoolHistory | null;
  /** The range the server rendered `history` and `candles` for (from the page URL). */
  initialRange?: ChartRangeId;
  /** Scope the Volume series to one venue (the bonding curve). A scoped panel has no TVL tab: TVL belongs to the V4 pool. */
  venue?: 'curve';
}) {
  const loadHistory = useCallback((range: ChartRangeId) => getLaunchHistory(chainId, tokenAddress, range, venue), [chainId, tokenAddress, venue]);
  return <ChartTypePanel loadHistory={loadHistory} history={history} initialRange={initialRange} showTvl={venue === undefined} headerClassName="min-h-8 text-2xl"
    price={({ tabs, range, onSelectRange }) => <OfficialPriceChart {...price} range={range} onSelectRange={onSelectRange} trailing={tabs} />} />;
}
