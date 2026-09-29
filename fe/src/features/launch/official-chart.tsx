'use client';

import { CandlestickSeries, createChart, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { Candle } from '@/api/client';
import { toChartValue } from '@/api/format';
import { CoverageBadge } from './coverage-badge';

export interface OfficialChartProps {
  candles: readonly Candle[];
  graduationTime: number | null;
  quoteSymbol: string;
  coverageStatus: string;
}

export function OfficialChart({ candles, graduationTime, quoteSymbol, coverageStatus }: OfficialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
    series.setData(
      candles.map((candle) => ({
        time: candle.bucketStart as UTCTimestamp,
        open: toChartValue(candle.open),
        high: toChartValue(candle.high),
        low: toChartValue(candle.low),
        close: toChartValue(candle.close),
      })),
    );

    if (graduationTime !== null) {
      createSeriesMarkers(series, [
        {
          time: graduationTime as UTCTimestamp,
          position: 'aboveBar',
          color: '#22d3ee',
          shape: 'arrowDown',
          text: 'Chuyển sang V4',
        },
      ]);
    }

    return () => chart.remove();
  }, [candles, graduationTime]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <CoverageBadge status={coverageStatus} />
        <p className="text-xs text-muted-foreground">
          Giá trên biểu đồ ({quoteSymbol}) là giá trị xấp xỉ để vẽ; xem bảng giao dịch cho số liệu chính xác.
        </p>
      </div>
      <div ref={containerRef} data-testid="official-chart-container" className="h-80 w-full" />
    </div>
  );
}
