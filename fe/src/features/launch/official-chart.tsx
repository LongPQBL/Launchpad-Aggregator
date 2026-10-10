'use client';

import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
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
import { CoverageBadge } from './coverage-badge';

export interface OfficialChartCandle { bucketStart: number; open: string; high: string; low: string; close: string }

export const CHART_INTERVALS = [
  { seconds: 60, label: '1m' },
  { seconds: 300, label: '5m' },
  { seconds: 900, label: '15m' },
  { seconds: 3600, label: '1h' },
  { seconds: 86400, label: '1D' },
] as const;
export const DEFAULT_CHART_INTERVAL = 3600;

// The resource this chart's interval tabs refetch from — a Client Component can't take a server-
// passed closure (Server Components may only pass serializable props), so this identifies the
// launch/pool by plain data and getLaunchCandles/getPoolCandles are called from inside this
// client module instead of being injected. Provide at most one; omitting both still renders the
// initial `candles` prop, just without a working interval switcher.
export interface OfficialChartSource {
  launch?: { chainId: number; tokenAddress: string; /** Only this venue's candles (the bonding curve). */ venue?: 'curve' };
  pool?: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken'>;
}

// The point the user is currently pointing at, in whichever currency the chart is actively
// showing — a caller rendering its own headline price (launch-detail.tsx, pool-chart.tsx) uses
// this to swap its static "current price" for the hovered point's close, matching how Uniswap's
// own chart header tracks the cursor. `null` means "not hovering," i.e. show the default price.
export interface OfficialChartHoverPoint { time: number; close: number; currency: 'quote' | 'usd' }

// First and latest close of the candles currently on the chart (after an interval/currency
// switch), so a caller can show the change across the visible range. `null` = no candles.
export interface OfficialChartRange { startClose: number; latestClose: number }

export interface OfficialChartProps {
  candles: readonly OfficialChartCandle[];
  graduationTime: number | null;
  quoteSymbol: string | null;
  coverageStatus: string;
  currency?: 'quote' | 'usd';
  intervalSeconds?: number;
  tokenSymbol?: string | null;
  source?: OfficialChartSource;
  // Pools have no USD candle series (getPoolCandles takes no currency param), so their chart
  // never offers a quote/USD toggle — showing one would silently fall back to quote prices under
  // a button labeled USD, which reads as real USD data.
  showCurrencyToggle?: boolean;
  onHoverPoint?: (point: OfficialChartHoverPoint | null) => void;
  onRangeChange?: (range: OfficialChartRange | null) => void;
  /** Rendered on the right of the interval-tabs row (e.g. a Price / Volume / TVL switcher). */
  trailing?: ReactNode;
}

export function OfficialChart({ candles, graduationTime, quoteSymbol, coverageStatus, currency = 'quote', intervalSeconds = DEFAULT_CHART_INTERVAL, tokenSymbol, source, showCurrencyToggle = true, onHoverPoint, onRangeChange, trailing }: OfficialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const requestIdRef = useRef(0);
  const [activeCurrency, setActiveCurrency] = useState(currency);
  const [activeInterval, setActiveInterval] = useState(intervalSeconds);
  const [chartCandles, setChartCandles] = useState(candles);

  // The crosshair-move subscription below is set up once on mount (recreating the chart on every
  // render would reset the user's zoom/pan) — a ref keeps it calling the latest onHoverPoint/
  // activeCurrency instead of whatever closure existed at mount time.
  const onHoverPointRef = useRef(onHoverPoint);
  useEffect(() => { onHoverPointRef.current = onHoverPoint; }, [onHoverPoint]);
  const onRangeChangeRef = useRef(onRangeChange);
  useEffect(() => { onRangeChangeRef.current = onRangeChange; }, [onRangeChange]);
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

  const selectChart = useCallback((nextCurrency: 'quote' | 'usd', nextInterval: number, updateHistory = true) => {
    setActiveCurrency(nextCurrency);
    setActiveInterval(nextInterval);
    onHoverPointRef.current?.(null);

    if (updateHistory && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('currency', nextCurrency);
      url.searchParams.set('interval', String(nextInterval));
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }

    const fetchPage = source?.launch
      ? getLaunchCandles(source.launch.chainId, source.launch.tokenAddress, { currency: nextCurrency, intervalSeconds: nextInterval, venue: source.launch.venue })
      : source?.pool
        ? getPoolCandles(source.pool, nextInterval)
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
  }, [source]);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const nextCurrency = showCurrencyToggle ? params.get('currency') === 'usd' ? 'usd' : 'quote' : currency;
      const requestedInterval = Number(params.get('interval'));
      const nextInterval = CHART_INTERVALS.some((item) => item.seconds === requestedInterval)
        ? requestedInterval
        : DEFAULT_CHART_INTERVAL;
      selectChart(nextCurrency, nextInterval, false);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectChart, showCurrencyToggle, currency]);

  // Adopt new props during render (React's "adjust state during render" pattern); only the hover
  // callback, an external side effect, stays in an effect.
  const [syncedProps, setSyncedProps] = useState({ candles, currency, intervalSeconds });
  if (syncedProps.candles !== candles || syncedProps.currency !== currency || syncedProps.intervalSeconds !== intervalSeconds) {
    setSyncedProps({ candles, currency, intervalSeconds });
    setActiveCurrency(currency);
    setActiveInterval(intervalSeconds);
    setChartCandles(candles);
  }
  useEffect(() => {
    onHoverPointRef.current?.(null);
  }, [candles, currency, intervalSeconds]);

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
    const series = chart.addSeries(CandlestickSeries);
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    // Reports the point the user is pointing at (param.time is undefined outside the chart's
    // data range, e.g. on mouse leave) so a caller's own headline price can track the cursor.
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const data = param.time !== undefined ? (param.seriesData.get(series) as CandlestickData<Time> | undefined) : undefined;
      onHoverPointRef.current?.(data ? { time: Number(data.time), close: data.close, currency: activeCurrencyRef.current } : null);
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      seriesRef.current = null;
      markersRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

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

    series.setData(
      ascendingCandles.map((candle) => ({
        time: candle.bucketStart as UTCTimestamp,
        open: toChartValue(candle.open),
        high: toChartValue(candle.high),
        low: toChartValue(candle.low),
        close: toChartValue(candle.close),
      })),
    );

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
  }, [ascendingCandles, priceFormat, formatAxisValue, graduationTime, tokenSymbol, latestCandle]);

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
            <a className={currencyTabClass(activeCurrency === 'quote')} href={`?currency=quote&interval=${activeInterval}`} aria-current={activeCurrency === 'quote' ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); selectChart('quote', activeInterval); }}>{displaySymbol(quoteSymbol)}</a>
            <a className={currencyTabClass(activeCurrency === 'usd')} href={`?currency=usd&interval=${activeInterval}`} aria-current={activeCurrency === 'usd' ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); selectChart('usd', activeInterval); }}>USD</a>
          </nav>
          )}
        </div>
      </div>
      <div ref={containerRef} data-testid="official-chart-container" className="h-80 w-full" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Chart interval" className="chart-interval-tabs inline-flex flex-wrap gap-1 rounded-md p-1 text-xs">
        {CHART_INTERVALS.map((interval) => (
          <a key={interval.seconds} className="chart-interval-tab rounded px-2.5 py-1.5" href={`?currency=${activeCurrency}&interval=${interval.seconds}`}
            aria-current={interval.seconds === activeInterval ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); selectChart(activeCurrency, interval.seconds); }}>{interval.label}</a>
        ))}
      </nav>
      {trailing}
      </div>
    </div>
  );
}

// The same interval tabs as the chart's own, for charts that fetch a different series (pool Volume / TVL history).
export function ChartIntervalTabs({ active, onSelect }: { active: number; onSelect: (seconds: number) => void }) {
  return (
    <nav aria-label="Chart interval" className="chart-interval-tabs inline-flex flex-wrap gap-1 rounded-md p-1 text-xs">
      {CHART_INTERVALS.map((interval) => (
        <a key={interval.seconds} className="chart-interval-tab rounded px-2.5 py-1.5" href={`?interval=${interval.seconds}`}
          aria-current={interval.seconds === active ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); onSelect(interval.seconds); }}>{interval.label}</a>
      ))}
    </nav>
  );
}
