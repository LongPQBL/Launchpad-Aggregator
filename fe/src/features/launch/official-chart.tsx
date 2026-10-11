'use client';

import {
  AreaSeries,
  CandlestickSeries,
  LineType,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type LineData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getLaunchCandles, getPoolCandles, type PoolSummary } from '@/api/client';
import { computeChartPrecision, displaySymbol, toChartValue } from '@/api/format';
import { CHART_RANGES, DEFAULT_CHART_RANGE, parseChartRange, type ChartRangeId } from '@/features/chart/ranges';
import { CoverageBadge } from './coverage-badge';

/** How the price is drawn: OHLC candles, or a line through each bucket's close. */
export type PriceChartStyle = 'candles' | 'line';

export interface OfficialChartCandle { bucketStart: number; open: string; high: string; low: string; close: string }

// The resource this chart's range tabs refetch from — a Client Component can't take a server-
// passed closure (Server Components may only pass serializable props), so this identifies the
// launch/pool by plain data and getLaunchCandles/getPoolCandles are called from inside this
// client module instead of being injected. Provide at most one; omitting both still renders the
// initial `candles` prop, just without a working range switcher.
export interface OfficialChartSource {
  launch?: { chainId: number; tokenAddress: string; /** Only this venue's candles (the bonding curve). */ venue?: 'curve' };
  pool?: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken'>;
}

// The point the user is currently pointing at, in whichever currency the chart is actively
// showing — a caller rendering its own headline price (launch-detail.tsx, pool-chart.tsx) uses
// this to swap its static "current price" for the hovered point's close, matching how Uniswap's
// own chart header tracks the cursor. `null` means "not hovering," i.e. show the default price.
export interface OfficialChartHoverPoint { time: number; close: number; currency: 'quote' | 'usd' }

// First and latest close of the candles currently on the chart (after a range/currency
// switch), so a caller can show the change across the visible range. `null` = no candles.
export interface OfficialChartRange { startClose: number; latestClose: number }

export interface OfficialChartProps {
  candles: readonly OfficialChartCandle[];
  graduationTime: number | null;
  quoteSymbol: string | null;
  coverageStatus: string;
  currency?: 'quote' | 'usd';
  /** The time range shown (the server picks the candle size). Controlled by the parent when it also passes `onSelectRange`. */
  range?: ChartRangeId;
  /** Called when the user picks a range tab, so a parent can keep other charts on the same range. */
  onSelectRange?: (range: ChartRangeId) => void;
  tokenSymbol?: string | null;
  source?: OfficialChartSource;
  // Pools have no USD candle series (getPoolCandles takes no currency param), so their chart
  // never offers a quote/USD toggle — showing one would silently fall back to quote prices under
  // a button labeled USD, which reads as real USD data.
  showCurrencyToggle?: boolean;
  onHoverPoint?: (point: OfficialChartHoverPoint | null) => void;
  onRangeChange?: (range: OfficialChartRange | null) => void;
  /** Rendered on the right of the range-tabs row (e.g. a Price / Volume / TVL switcher). */
  trailing?: ReactNode;
  /** Candles (default) or a line through the closes; switching keeps the zoom and data. */
  chartStyle?: PriceChartStyle;
}

export function OfficialChart({ candles, graduationTime, quoteSymbol, coverageStatus, currency = 'quote', range = DEFAULT_CHART_RANGE, onSelectRange, tokenSymbol, source, showCurrencyToggle = true, onHoverPoint, onRangeChange, trailing, chartStyle = 'candles' }: OfficialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const requestIdRef = useRef(0);
  // What `chartCandles` currently shows, as `currency:range`; the fetch effect below loads whatever the tabs select next.
  const loadedKeyRef = useRef(`${currency}:${range}`);
  const [activeCurrency, setActiveCurrency] = useState(currency);
  const [activeRange, setActiveRange] = useState(range);
  const [chartCandles, setChartCandles] = useState(candles);

  // The crosshair-move subscription below is set up once on mount (recreating the chart on every
  // render would reset the user's zoom/pan) — a ref keeps it calling the latest onHoverPoint/
  // activeCurrency instead of whatever closure existed at mount time.
  const onHoverPointRef = useRef(onHoverPoint);
  useEffect(() => { onHoverPointRef.current = onHoverPoint; }, [onHoverPoint]);
  const onRangeChangeRef = useRef(onRangeChange);
  useEffect(() => { onRangeChangeRef.current = onRangeChange; }, [onRangeChange]);
  const onSelectRangeRef = useRef(onSelectRange);
  useEffect(() => { onSelectRangeRef.current = onSelectRange; }, [onSelectRange]);
  const activeCurrencyRef = useRef(activeCurrency);
  useEffect(() => { activeCurrencyRef.current = activeCurrency; }, [activeCurrency]);

  // be/src/api/store.ts's listCandles returns candles newest-first (it reverses an ascending
  // query); Lightweight Charts requires strictly ascending time and throws otherwise.
  const ascendingCandles = useMemo(
    () => [...chartCandles].sort((a, b) => a.bucketStart - b.bucketStart),
    [chartCandles],
  );
  const priceFormat = useMemo(() => computeChartPrecision(chartCandles.map((candle) => candle.close)), [chartCandles]);
  const formatAxisValue = useCallback(
    (value: number) => `${activeCurrency === 'usd' ? '$' : ''}${value.toFixed(priceFormat.precision)}`,
    [activeCurrency, priceFormat],
  );
  const latestCandle = ascendingCandles.at(-1);

  useEffect(() => {
    const first = ascendingCandles[0];
    onRangeChangeRef.current?.(first && latestCandle ? { startClose: Number(first.close), latestClose: Number(latestCandle.close) } : null);
  }, [ascendingCandles, latestCandle]);

  const selectChart = useCallback((nextCurrency: 'quote' | 'usd', nextRange: ChartRangeId, updateHistory = true) => {
    setActiveCurrency(nextCurrency);
    setActiveRange(nextRange);
    onHoverPointRef.current?.(null);
    onSelectRangeRef.current?.(nextRange);

    if (updateHistory && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('currency', nextCurrency);
      url.searchParams.set('range', nextRange);
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  // Loads the candles for the selected currency/range, whether the user clicked here or a sibling chart moved the shared range.
  useEffect(() => {
    const key = `${activeCurrency}:${activeRange}`;
    if (key === loadedKeyRef.current) return;
    loadedKeyRef.current = key;
    const fetchPage = source?.launch
      ? getLaunchCandles(source.launch.chainId, source.launch.tokenAddress, { currency: activeCurrency, range: activeRange, venue: source.launch.venue })
      : source?.pool
        ? getPoolCandles(source.pool, activeRange)
        : undefined;
    if (!fetchPage) return;
    const requestId = ++requestIdRef.current;
    void fetchPage
      .then((page) => {
        if (requestId === requestIdRef.current) setChartCandles(page.items);
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setChartCandles([]);
      });
  }, [activeCurrency, activeRange, source]);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const nextCurrency = showCurrencyToggle ? params.get('currency') === 'usd' ? 'usd' : 'quote' : currency;
      selectChart(nextCurrency, parseChartRange(params.get('range')), false);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectChart, showCurrencyToggle, currency]);

  // Adopt new server data during render (React's "adjust state during render" pattern); a bare range change from a
  // sibling chart only moves the tab and lets the fetch effect load that range. The hover callback, an external side
  // effect, stays in an effect.
  const [syncedProps, setSyncedProps] = useState({ candles, currency, range });
  if (syncedProps.candles !== candles || syncedProps.currency !== currency) {
    setSyncedProps({ candles, currency, range });
    setActiveCurrency(currency);
    setActiveRange(range);
    setChartCandles(candles);
  } else if (syncedProps.range !== range) {
    setSyncedProps({ candles, currency, range });
    setActiveRange(range);
  }
  useEffect(() => {
    loadedKeyRef.current = `${currency}:${range}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- server data (candles/currency) defines what is loaded; a range-only change must still fetch
  }, [candles, currency]);
  useEffect(() => {
    onHoverPointRef.current?.(null);
  }, [candles, currency, range]);

  // Creates the chart once. Re-creating it on every data update (candles is a fresh array
  // reference each live-refresh) would reset the user's zoom/pan every time.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        attributionLogo: true,
        background: { color: '#0a0a0b' },
        textColor: '#a1a1aa',
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: '#27272a' },
      timeScale: { borderColor: '#27272a' },
    });
    chartRef.current = chart;

    // Reports the point the user is pointing at (param.time is undefined outside the chart's
    // data range, e.g. on mouse leave) so a caller's own headline price can track the cursor.
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const series = seriesRef.current;
      const data = param.time !== undefined && series ? (param.seriesData.get(series) as (CandlestickData<Time> | LineData<Time>) | undefined) : undefined;
      const close = data === undefined ? undefined : 'close' in data ? data.close : data.value;
      onHoverPointRef.current?.(data && close !== undefined ? { time: Number(data.time), close, currency: activeCurrencyRef.current } : null);
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

  // Swaps the series when the style changes, on the same chart so the zoom/pan survives. Declared before the data effect so
  // that, in the same commit, the data effect redraws onto the new series.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const series = chartStyle === 'line'
      ? chart.addSeries(AreaSeries, { lineColor: '#22c55e', topColor: '#22c55e40', bottomColor: '#22c55e00', lineWidth: 2, lineType: LineType.Curved })
      : chart.addSeries(CandlestickSeries);
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    priceLineRef.current = null;
    return () => {
      // On unmount the chart's own cleanup (declared earlier) has already removed the chart and its series.
      if (chartRef.current === chart) chart.removeSeries(series);
      if (seriesRef.current === series) { seriesRef.current = null; markersRef.current = null; priceLineRef.current = null; }
    };
  }, [chartStyle]);

  // Updates data on the existing chart/series instead of recreating them.
  useEffect(() => {
    const series = seriesRef.current;
    const markers = markersRef.current;
    if (!series || !markers) return;

    series.applyOptions({
      priceFormat: {
        type: 'custom',
        minMove: priceFormat.minMove,
        formatter: formatAxisValue,
      },
    });

    if (chartStyle === 'line') {
      (series as ISeriesApi<'Area'>).setData(
        ascendingCandles.map((candle) => ({ time: candle.bucketStart as UTCTimestamp, value: toChartValue(candle.close) })),
      );
    } else {
      (series as ISeriesApi<'Candlestick'>).setData(
        ascendingCandles.map((candle) => ({
          time: candle.bucketStart as UTCTimestamp,
          open: toChartValue(candle.open),
          high: toChartValue(candle.high),
          low: toChartValue(candle.low),
          close: toChartValue(candle.close),
        })),
      );
    }

    if (priceLineRef.current) series.removePriceLine(priceLineRef.current);
    priceLineRef.current = latestCandle
      ? series.createPriceLine({
          price: toChartValue(latestCandle.close),
          color: '#22c55e',
          lineWidth: 1,
          axisLabelVisible: true,
          title: tokenSymbol ? displaySymbol(tokenSymbol) : 'Price',
        })
      : null;

    markers.setMarkers(
      graduationTime !== null
        ? [
            {
              time: graduationTime as UTCTimestamp,
              position: 'aboveBar',
              color: '#ccff00',
              shape: 'arrowDown',
              text: 'First V4 trade',
            },
          ]
        : [],
    );
  }, [ascendingCandles, priceFormat, formatAxisValue, graduationTime, tokenSymbol, latestCandle, chartStyle]);

  const currencyTabClass = (active: boolean) => active
    ? 'rounded px-2.5 py-1.5 text-foreground bg-background shadow-sm'
    : 'rounded px-2.5 py-1.5 text-muted-foreground hover:bg-background/70 hover:text-foreground';

  return (
    <div>
      <div className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CoverageBadge status={coverageStatus} />
          {showCurrencyToggle && (
          <nav aria-label="Chart currency" className="ml-auto inline-flex flex-wrap gap-1 rounded-md border border-border bg-muted p-1 text-xs">
            <a className={currencyTabClass(activeCurrency === 'quote')} href={`?currency=quote&range=${activeRange}`} aria-current={activeCurrency === 'quote' ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); selectChart('quote', activeRange); }}>{displaySymbol(quoteSymbol)}</a>
            <a className={currencyTabClass(activeCurrency === 'usd')} href={`?currency=usd&range=${activeRange}`} aria-current={activeCurrency === 'usd' ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); selectChart('usd', activeRange); }}>USD</a>
          </nav>
          )}
        </div>
      </div>
      <div ref={containerRef} data-testid="official-chart-container" className="h-80 w-full" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Chart range" className="chart-interval-tabs inline-flex flex-wrap gap-1 rounded-md p-1 text-xs">
        {CHART_RANGES.map((item) => (
          <a key={item.id} className="chart-interval-tab rounded px-2.5 py-1.5" href={`?currency=${activeCurrency}&range=${item.id}`}
            aria-current={item.id === activeRange ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); selectChart(activeCurrency, item.id); }}>{item.label}</a>
        ))}
      </nav>
      {trailing}
      </div>
    </div>
  );
}

// The same range tabs as the price chart's own, for charts that fetch a different series (Volume / TVL history).
export function ChartRangeTabs({ active, onSelect }: { active: ChartRangeId; onSelect: (range: ChartRangeId) => void }) {
  return (
    <nav aria-label="Chart range" className="chart-interval-tabs inline-flex flex-wrap gap-1 rounded-md p-1 text-xs">
      {CHART_RANGES.map((item) => (
        <a key={item.id} className="chart-interval-tab rounded px-2.5 py-1.5" href={`?range=${item.id}`}
          aria-current={item.id === active ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); onSelect(item.id); }}>{item.label}</a>
      ))}
    </nav>
  );
}
