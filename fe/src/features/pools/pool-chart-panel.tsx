'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getPoolHistory, type PoolCandlePage, type PoolHistory, type PoolSummary } from '@/api/client';
import { CHART_KINDS, type ChartKind } from '@/features/chart/chart-kinds';
import { DEFAULT_CHART_RANGE, type ChartRangeId } from '@/features/chart/ranges';
import { ChartRangeTabs, type PriceChartStyle } from '@/features/launch/official-chart';
import { POOL_CHANGED_EVENT } from '@/hooks/live-events';
import type { SseEventPayload } from '@/hooks/resource-keys';
import { useLiveFirstPage } from '@/hooks/use-live-first-page';
import { cn } from '@/lib/utils';
import { PoolChart } from './pool-chart';
import { PoolHistoryChart, trimLeadingEmpty } from './pool-history-chart';
import { PoolDepthChart, PoolLiquidityChart } from './pool-liquidity';


const STYLE_STORAGE_KEY = 'chartStyle';

// Candles by default; the choice is remembered like the theme. Read after mount so the server and first client render agree.
function usePriceChartStyle(): [PriceChartStyle, (style: PriceChartStyle) => void] {
  const [style, setStyle] = useState<PriceChartStyle>('candles');
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restores the saved choice after hydration
      if (window.localStorage.getItem(STYLE_STORAGE_KEY) === 'line') setStyle('line');
    } catch { /* storage unavailable: keep the default */ }
  }, []);
  const choose = useCallback((next: PriceChartStyle) => {
    setStyle(next);
    try { window.localStorage.setItem(STYLE_STORAGE_KEY, next); } catch { /* not persisted */ }
  }, []);
  return [style, choose];
}

function ChartStyleTabs({ selected, onSelect }: { selected: PriceChartStyle; onSelect: (style: PriceChartStyle) => void }) {
  const items: { id: PriceChartStyle; label: string; icon: ReactNode }[] = [
    { id: 'line', label: 'Line chart', icon: <path d="M3 17l5-6 4 3 8-9" /> },
    { id: 'candles', label: 'Candlestick chart', icon: <><path d="M7 4v3M7 17v3M17 7v2M17 15v3" /><rect x="5" y="7" width="4" height="10" /><rect x="15" y="9" width="4" height="6" /></> },
  ];
  return (
    <div role="tablist" aria-label="Price chart style" className="inline-flex gap-1 rounded-full border border-border p-1">
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={selected === item.id} aria-label={item.label} title={item.label} onClick={() => onSelect(item.id)}
          className={cn('cursor-pointer rounded-full px-2.5 py-1.5', selected === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{item.icon}</svg>
        </button>
      ))}
    </div>
  );
}

function ChartKindTabs({ kinds, selected, onSelect }: { kinds: readonly ChartKind[]; selected: ChartKind; onSelect: (kind: ChartKind) => void }) {
  return (
    <div role="tablist" aria-label="Chart type" className="inline-flex gap-1 rounded-full border border-border p-1">
      {kinds.map((kind) => (
        <button key={kind} type="button" role="tab" aria-selected={selected === kind} onClick={() => onSelect(kind)}
          className={cn('cursor-pointer rounded-full px-3 py-1.5 text-xs', selected === kind ?'bg-muted text-foreground' :'text-muted-foreground hover:text-foreground')}>
          {CHART_KINDS[kind].label}
        </button>
      ))}
    </div>
  );
}

// One chart area: the Price / Volume (/ TVL) switcher sits under the chart, on the right of the range tabs,
// and picks which chart is drawn. All kinds share one time range (the server picks the bucket size): the price chart
// stays mounted (just hidden), follows the shared range and keeps its zoom, while Volume / TVL load their series per
// range. `showTvl` is on for the launch page and off for the pool page, which has no TVL chart.
export function ChartTypePanel({ loadHistory, history, price, headerClassName, showTvl = true, allPools = false, extra, initialRange = DEFAULT_CHART_RANGE, live }: {
  /** Fetches the Volume / TVL series for a range (the first page arrives as `history`, for `initialRange`). */
  loadHistory: (range: ChartRangeId) => Promise<PoolHistory>;
  history: PoolHistory | null;
  /** The price chart, given the Price / Volume / TVL tabs to place in its range row and the shared range; null when there is no price chart. */
  price: ((options: { tabs: ReactNode; range: ChartRangeId; onSelectRange: (range: ChartRangeId) => void; chartStyle: PriceChartStyle }) => ReactNode) | null;
  /** Height of the readout line above the history chart; match the price chart's own header. */
  headerClassName?: string;
  /** Offer the TVL tab next to Volume. */
  showTvl?: boolean;
  /** Volume / TVL cover every pool of a token (the token page); only the wording of the notes under the chart differs. */
  allPools?: boolean;
  /** Charts that need neither a range nor a style (Liquidity, Depth): given the tab switcher to place under them. */
  extra?: Partial<Record<'liquidity' | 'curve' | 'depth', (options: { tabs: ReactNode }) => ReactNode>>;
  /** The range the server rendered `history` and the price candles for (from the page URL). */
  initialRange?: ChartRangeId;
  /** When set, a matching announcement reloads the Volume / TVL series for the range on screen. */
  live?: { eventName: string | readonly string[]; matches: (payload: SseEventPayload) => boolean; key: string };
}) {
  const kinds: ChartKind[] = [...(price ? ['price' as const] : []), ...(history ? ['volume' as const, ...(showTvl ? ['tvl' as const] : [])] : []),
    ...(extra?.liquidity ? ['liquidity' as const] : []), ...(extra?.curve ? ['curve' as const] : []), ...(extra?.depth ? ['depth' as const] : [])];
  const [selected, setSelected] = useState<ChartKind>(kinds[0] ?? 'price');
  const [chartStyle, setChartStyle] = usePriceChartStyle();
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

  // An announced change (a swap, recomputed buckets) reloads the series for the range on screen. Other ranges' cached series are dropped:
  // they are as stale as this one was, and switching to one reloads it.
  useLiveFirstPage(
    (payload) => live !== undefined && history !== null && live.matches(payload),
    async (isStale) => {
      const range = latestRange.current;
      const loaded = await loadHistory(range);
      if (isStale() || latestRange.current !== range) return;
      cache.current = new Map([[range, loaded]]);
      setData(loaded);
    },
    [live?.key, loadHistory, history !== null],
    live?.eventName,
  );

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
  const kindTabs = kinds.length > 1 ? <ChartKindTabs kinds={kinds} selected={selected} onSelect={setSelected} /> : null;
  // The line / candles switch only means something for the price chart, so it sits beside the kind tabs only there.
  const tabs = (
    <div className="flex items-center gap-2">
      {price && CHART_KINDS[selected].usesChartStyle && <ChartStyleTabs selected={chartStyle} onSelect={setChartStyle} />}
      {kindTabs}
    </div>
  );
  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- the callback only reads the stale-answer ref when the user clicks, never while rendering */}
      {price && <div hidden={selected !== 'price'}>{price({ tabs, range: activeRange, onSelectRange: selectFromChart, chartStyle })}</div>}
      {(selected === 'liquidity' || selected === 'curve' || selected === 'depth') && extra?.[selected]?.({ tabs: kindTabs })}
      {history && (selected === 'volume' || selected === 'tvl') && (
        <PoolHistoryChart items={activeRange === 'all' ? trimLeadingEmpty(data?.items ?? []) : data?.items ?? []} complete={data?.complete ?? history.complete} metric={selected} headerClassName={headerClassName}
          intervalSeconds={data?.intervalSeconds} loading={loading} error={failed} allPools={allPools} unvaluedPools={data?.unvaluedPools ?? history.unvaluedPools ?? 0}
          leading={<ChartRangeTabs active={activeRange} onSelect={selectFromHistory} />} trailing={kindTabs} />
      )}
    </>
  );
}

export function PoolChartPanel({ pool, candles, history, coverageStatus, quoteSymbol, tokenSymbol, initialRange = DEFAULT_CHART_RANGE }: {
  pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken' | 'priceInQuote' | 'priceUsd' | 'currency0Symbol' | 'currency1Symbol'>;
  candles: PoolCandlePage | null; history: PoolHistory | null; coverageStatus: string; quoteSymbol: string; tokenSymbol: string | null;
  initialRange?: ChartRangeId;
}) {
  const loadHistory = useCallback((range: ChartRangeId) => getPoolHistory(pool, range), [pool]);
  // Liquidity and Depth need tick data: V3 and V4 pools only (a V2 pair has none).
  const extra = pool.protocol === 'uniswap_v2' ? undefined : {
    liquidity: ({ tabs }: { tabs: ReactNode }) => <PoolLiquidityChart pool={pool} trailing={tabs} />,
    depth: ({ tabs }: { tabs: ReactNode }) => <PoolDepthChart pool={pool} trailing={tabs} />,
  };
  const live = { eventName: POOL_CHANGED_EVENT, key: `${pool.chainId}:${pool.protocol}:${pool.poolId}`,
    matches: (payload: SseEventPayload) => payload.chainId === pool.chainId && payload.poolId === pool.poolId.toLowerCase() };
  return <ChartTypePanel loadHistory={loadHistory} history={history} showTvl={false} initialRange={initialRange} extra={extra} live={live}
    price={candles ? ({ tabs, range, onSelectRange, chartStyle }) => <PoolChart pool={pool} candles={candles} coverageStatus={coverageStatus} quoteSymbol={quoteSymbol} tokenSymbol={tokenSymbol}
      range={range} onSelectRange={onSelectRange} trailing={tabs} chartStyle={chartStyle} /> : null} />;
}
