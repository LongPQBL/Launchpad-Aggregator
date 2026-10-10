'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getPoolHistory, type PoolCandlePage, type PoolHistory, type PoolSummary } from '@/api/client';
import { ChartIntervalTabs } from '@/features/launch/official-chart';
import { cn } from '@/lib/utils';
import { PoolChart } from './pool-chart';
import { PoolHistoryChart } from './pool-history-chart';

type ChartKind = 'price' | 'volume' | 'tvl';
const DAILY = 86_400;
const LABELS: Record<ChartKind, string> = { price: 'Price', volume: 'Volume', tvl: 'TVL' };

function ChartKindTabs({ kinds, selected, onSelect }: { kinds: readonly ChartKind[]; selected: ChartKind; onSelect: (kind: ChartKind) => void }) {
  return (
    <div role="tablist" aria-label="Chart type" className="inline-flex gap-1 rounded-full border border-border p-1">
      {kinds.map((kind) => (
        <button key={kind} type="button" role="tab" aria-selected={selected === kind} onClick={() => onSelect(kind)}
          className={cn('cursor-pointer rounded-full px-3 py-1.5 text-xs', selected === kind ?'bg-muted text-foreground' :'text-muted-foreground hover:text-foreground')}>
          {LABELS[kind]}
        </button>
      ))}
    </div>
  );
}

// One chart area: the Price / Volume (/ TVL) switcher sits under the chart, on the right of the interval tabs,
// and picks which chart is drawn. The price chart stays mounted (just hidden) so its interval and zoom survive a
// trip to Volume or TVL; they share one interval and fetch their series per interval. `showTvl` is on for the
// launch page and off for the pool page, which has no TVL chart.
export function ChartTypePanel({ loadHistory, history, price, headerClassName, showTvl = true }: {
  /** Fetches the Volume / TVL series for an interval (the first, daily page arrives as `history`). */
  loadHistory: (intervalSeconds: number) => Promise<PoolHistory>;
  history: PoolHistory | null;
  /** The price chart, given the Price / Volume / TVL tabs to place in its interval row; null when there is no price chart. */
  price: ((tabs: ReactNode) => ReactNode) | null;
  /** Height of the readout line above the history chart; match the price chart's own header. */
  headerClassName?: string;
  /** Offer the TVL tab next to Volume. */
  showTvl?: boolean;
}) {
  const kinds: ChartKind[] = [...(price ? ['price' as const] : []), ...(history ? ['volume' as const, ...(showTvl ? ['tvl' as const] : [])] : [])];
  const [selected, setSelected] = useState<ChartKind>(kinds[0] ?? 'price');
  const [activeInterval, setActiveInterval] = useState(DAILY);
  const latestInterval = useRef(DAILY);
  const cache = useRef(new Map<number, PoolHistory>(history ? [[DAILY, history]] : []));
  const [data, setData] = useState<PoolHistory | null>(history);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const selectInterval = useCallback(async (next: number) => {
    latestInterval.current = next;
    setActiveInterval(next);
    setFailed(false);
    const cached = cache.current.get(next);
    if (cached) { setData(cached); return; }
    setLoading(true);
    try {
      const loaded = await loadHistory(next);
      cache.current.set(next, loaded);
      // Ignore an answer for an interval the user has already left.
      if (latestInterval.current === next) setData(loaded);
    } catch {
      if (latestInterval.current === next) setFailed(true);
    } finally {
      if (latestInterval.current === next) setLoading(false);
    }
  }, [loadHistory]);

  const previousHistory = useRef(history);
  useEffect(() => {
    if (previousHistory.current === history) return;
    previousHistory.current = history;
    if (history) cache.current.set(DAILY, history);
    if (activeInterval === DAILY) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh server history page replaces the displayed daily series
      setData(history);
    } else if (history) {
      cache.current.delete(activeInterval);
      void selectInterval(activeInterval);
    }
  }, [history, activeInterval, selectInterval]);

  if (kinds.length === 0) return null;
  const tabs = kinds.length > 1 ? <ChartKindTabs kinds={kinds} selected={selected} onSelect={setSelected} /> : null;
  return (
    <>
      {price && <div hidden={selected !== 'price'}>{price(tabs)}</div>}
      {history && selected !== 'price' && (
        <PoolHistoryChart items={data?.items ?? []} complete={data?.complete ?? history.complete} metric={selected} headerClassName={headerClassName} intervalSeconds={activeInterval}
          loading={loading} error={failed} leading={<ChartIntervalTabs active={activeInterval} onSelect={(next) => { void selectInterval(next); }} />} trailing={tabs} />
      )}
    </>
  );
}

export function PoolChartPanel({ pool, candles, history, coverageStatus, quoteSymbol, tokenSymbol }: {
  pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken' | 'priceInQuote' | 'priceUsd'>;
  candles: PoolCandlePage | null; history: PoolHistory | null; coverageStatus: string; quoteSymbol: string; tokenSymbol: string | null;
}) {
  const loadHistory = useCallback((interval: number) => getPoolHistory(pool, interval), [pool]);
  return <ChartTypePanel loadHistory={loadHistory} history={history} showTvl={false}
    price={candles ? (tabs) => <PoolChart pool={pool} candles={candles} coverageStatus={coverageStatus} quoteSymbol={quoteSymbol} tokenSymbol={tokenSymbol} trailing={tabs} /> : null} />;
}
