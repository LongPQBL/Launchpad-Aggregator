'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getPoolHistory, type PoolCandlePage, type PoolHistory, type PoolSummary } from '@/api/client';
import { DEFAULT_CHART_RANGE, type ChartRangeId } from '@/features/chart/ranges';
import { ChartRangeTabs } from '@/features/launch/official-chart';
import { cn } from '@/lib/utils';
import { PoolChart } from './pool-chart';
import { PoolHistoryChart } from './pool-history-chart';

type ChartKind = 'price' | 'volume' | 'tvl';
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

// One chart area: the Price / Volume (/ TVL) switcher sits under the chart, on the right of the range tabs,
// and picks which chart is drawn. All kinds share one time range (the server picks the bucket size): the price chart
// stays mounted (just hidden), follows the shared range and keeps its zoom, while Volume / TVL load their series per
// range. `showTvl` is on for the launch page and off for the pool page, which has no TVL chart.
export function ChartTypePanel({ loadHistory, history, price, headerClassName, showTvl = true, initialRange = DEFAULT_CHART_RANGE }: {
  /** Fetches the Volume / TVL series for a range (the first page arrives as `history`, for `initialRange`). */
  loadHistory: (range: ChartRangeId) => Promise<PoolHistory>;
  history: PoolHistory | null;
  /** The price chart, given the Price / Volume / TVL tabs to place in its range row and the shared range; null when there is no price chart. */
  price: ((options: { tabs: ReactNode; range: ChartRangeId; onSelectRange: (range: ChartRangeId) => void }) => ReactNode) | null;
  /** Height of the readout line above the history chart; match the price chart's own header. */
  headerClassName?: string;
  /** Offer the TVL tab next to Volume. */
  showTvl?: boolean;
  /** The range the server rendered `history` and the price candles for (from the page URL). */
  initialRange?: ChartRangeId;
}) {
  const kinds: ChartKind[] = [...(price ? ['price' as const] : []), ...(history ? ['volume' as const, ...(showTvl ? ['tvl' as const] : [])] : [])];
  const [selected, setSelected] = useState<ChartKind>(kinds[0] ?? 'price');
  const [activeRange, setActiveRange] = useState(initialRange);
  const latestRange = useRef(initialRange);
  const cache = useRef(new Map<ChartRangeId, PoolHistory>(history ? [[initialRange, history]] : []));
  const [data, setData] = useState<PoolHistory | null>(history);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const applyRange = useCallback(async (next: ChartRangeId) => {
    latestRange.current = next;
    setActiveRange(next);
    setFailed(false);
    const cached = cache.current.get(next);
    if (cached) { setData(cached); return; }
    setLoading(true);
    try {
      const loaded = await loadHistory(next);
      cache.current.set(next, loaded);
      // Ignore an answer for a range the user has already left.
      if (latestRange.current === next) setData(loaded);
    } catch {
      if (latestRange.current === next) setFailed(true);
    } finally {
      if (latestRange.current === next) setLoading(false);
    }
  }, [loadHistory]);

  // The price chart updates the URL itself when its own tabs are used; the history view does it here.
  const selectFromHistory = useCallback((next: ChartRangeId) => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('range', next);
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    void applyRange(next);
  }, [applyRange]);

  const selectFromChart = useCallback((next: ChartRangeId) => { void applyRange(next); }, [applyRange]);

  const previousHistory = useRef(history);
  useEffect(() => {
    if (previousHistory.current === history) return;
    previousHistory.current = history;
    if (history) cache.current.set(initialRange, history);
    if (activeRange === initialRange) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh server history page replaces the displayed series
      setData(history);
    } else if (history) {
      cache.current.delete(activeRange);
      void applyRange(activeRange);
    }
  }, [history, activeRange, initialRange, applyRange]);

  if (kinds.length === 0) return null;
  const tabs = kinds.length > 1 ? <ChartKindTabs kinds={kinds} selected={selected} onSelect={setSelected} /> : null;
  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- the callback only reads the stale-answer ref when the user clicks, never while rendering */}
      {price && <div hidden={selected !== 'price'}>{price({ tabs, range: activeRange, onSelectRange: selectFromChart })}</div>}
      {history && selected !== 'price' && (
        <PoolHistoryChart items={data?.items ?? []} complete={data?.complete ?? history.complete} metric={selected} headerClassName={headerClassName}
          intervalSeconds={data?.intervalSeconds} loading={loading} error={failed}
          leading={<ChartRangeTabs active={activeRange} onSelect={selectFromHistory} />} trailing={tabs} />
      )}
    </>
  );
}

export function PoolChartPanel({ pool, candles, history, coverageStatus, quoteSymbol, tokenSymbol, initialRange = DEFAULT_CHART_RANGE }: {
  pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken' | 'priceInQuote' | 'priceUsd'>;
  candles: PoolCandlePage | null; history: PoolHistory | null; coverageStatus: string; quoteSymbol: string; tokenSymbol: string | null;
  initialRange?: ChartRangeId;
}) {
  const loadHistory = useCallback((range: ChartRangeId) => getPoolHistory(pool, range), [pool]);
  return <ChartTypePanel loadHistory={loadHistory} history={history} showTvl={false} initialRange={initialRange}
    price={candles ? ({ tabs, range, onSelectRange }) => <PoolChart pool={pool} candles={candles} coverageStatus={coverageStatus} quoteSymbol={quoteSymbol} tokenSymbol={tokenSymbol}
      range={range} onSelectRange={onSelectRange} trailing={tabs} /> : null} />;
}
