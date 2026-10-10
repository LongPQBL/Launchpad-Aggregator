'use client';

import { useCallback, type ComponentProps } from 'react';
import { getLaunchHistory, type PoolHistory } from '@/api/client';
import { ChartTypePanel } from '@/features/pools/pool-chart-panel';
import { OfficialPriceChart } from './official-price-chart';

// The launch page's chart area: the price chart plus the launch's official Volume and TVL bars per interval.
export function LaunchChartPanel({ chainId, tokenAddress, history, venue, ...price }: Omit<ComponentProps<typeof OfficialPriceChart>, 'trailing'> & {
  chainId: number; tokenAddress: string; history: PoolHistory | null;
  /** Scope the Volume series to one venue (the bonding curve). A scoped panel has no TVL tab: TVL belongs to the V4 pool. */
  venue?: 'curve';
}) {
  const loadHistory = useCallback((interval: number) => getLaunchHistory(chainId, tokenAddress, interval, venue), [chainId, tokenAddress, venue]);
  return <ChartTypePanel loadHistory={loadHistory} history={history} showTvl={venue === undefined} headerClassName="min-h-8 text-2xl"
    price={(tabs) => <OfficialPriceChart {...price} trailing={tabs} />} />;
}
