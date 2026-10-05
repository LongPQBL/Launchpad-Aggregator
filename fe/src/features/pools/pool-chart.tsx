import type { PoolCandlePage } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { OfficialChart } from '@/features/launch/official-chart';

export function PoolChart({ candles, coverageStatus, quoteSymbol }: { candles: PoolCandlePage; coverageStatus: string; quoteSymbol: string }) {
  return <Card><CardContent className="pt-4"><OfficialChart
    candles={candles.items.map((candle) => ({ ...candle, quoteVolume: '0' }))}
    graduationTime={null} quoteSymbol={quoteSymbol}
    coverageStatus={candles.complete ? coverageStatus : 'backfilling'} /></CardContent></Card>;
}
