'use client';

import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { computeChartPrecision, displaySymbol, toChartValue } from '@/api/format';
import { CoverageBadge } from './coverage-badge';

export interface OfficialChartCandle { bucketStart: number; open: string; high: string; low: string; close: string }

export interface OfficialChartProps {
  candles: readonly OfficialChartCandle[];
  graduationTime: number | null;
  quoteSymbol: string | null;
  coverageStatus: string;
  currency?: 'quote' | 'usd';
}

export function OfficialChart({ candles, graduationTime, quoteSymbol, coverageStatus, currency = 'quote' }: OfficialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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

    return () => {
      chart.remove();
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Updates data on the existing chart/series instead of recreating them.
  useEffect(() => {
    const series = seriesRef.current;
    const markers = markersRef.current;
    if (!series || !markers) return;

    const priceFormat = computeChartPrecision(candles.map((candle) => candle.close));
    series.applyOptions({ priceFormat: { type: 'price', ...priceFormat } });

    // be/src/api/store.ts's listCandles returns candles newest-first (it reverses an ascending
    // query); Lightweight Charts requires strictly ascending time and throws otherwise.
    const ascendingCandles = [...candles].sort((a, b) => a.bucketStart - b.bucketStart);
    series.setData(
      ascendingCandles.map((candle) => ({
        time: candle.bucketStart as UTCTimestamp,
        open: toChartValue(candle.open),
        high: toChartValue(candle.high),
        low: toChartValue(candle.low),
        close: toChartValue(candle.close),
      })),
    );

    markers.setMarkers(
      graduationTime !== null
        ? [
            {
              time: graduationTime as UTCTimestamp,
              position: 'aboveBar',
              color: '#22d3ee',
              shape: 'arrowDown',
              text: 'First V4 trade',
            },
          ]
        : [],
    );
  }, [candles, graduationTime]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <CoverageBadge status={coverageStatus} />
        <nav aria-label="Chart currency" className="flex gap-1 text-xs">
          <a href="?currency=quote" aria-current={currency === 'quote' ? 'page' : undefined}>{displaySymbol(quoteSymbol)}</a>
          <a href="?currency=usd" aria-current={currency === 'usd' ? 'page' : undefined}>USD</a>
        </nav>
        <p className="text-xs text-muted-foreground">
          {currency === 'usd' ? 'Chart prices (USD) are approximate for plotting; see the trade table for exact figures.' : `Chart prices (${displaySymbol(quoteSymbol)}) are approximate for plotting; see the trade table for exact figures.`}
        </p>
      </div>
      <div ref={containerRef} data-testid="official-chart-container" className="h-80 w-full" />
    </div>
  );
}
