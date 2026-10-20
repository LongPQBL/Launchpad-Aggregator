// The kinds of chart a panel can switch between, and what each one needs under it: a time range, a line / candle style, or nothing (the
// tab switcher alone). The panels read these flags instead of testing tab names, so a new kind only has to be declared here.
export type ChartKind = 'price' | 'volume' | 'tvl' | 'liquidity' | 'curve' | 'depth';
export interface ChartKindSpec { label: string; usesRange: boolean; usesChartStyle: boolean }

export const CHART_KINDS: Record<ChartKind, ChartKindSpec> = {
  price: { label: 'Price', usesRange: true, usesChartStyle: true },
  volume: { label: 'Volume', usesRange: true, usesChartStyle: false },
  tvl: { label: 'TVL', usesRange: true, usesChartStyle: false },
  liquidity: { label: 'Liquidity', usesRange: false, usesChartStyle: false },
  curve: { label: 'Curve', usesRange: false, usesChartStyle: false },
  depth: { label: 'Depth', usesRange: false, usesChartStyle: false },
};

// Liquidity and Depth are switched off for now (their code and endpoints stay). A hidden kind gets no tab and its chart is never mounted, so
// nothing is fetched or drawn for it. Set NEXT_PUBLIC_SHOW_DEPTH_CHARTS=true to bring both back.
const DEPTH_KINDS: readonly ChartKind[] = ['liquidity', 'depth'];
export function isChartKindHidden(kind: ChartKind): boolean {
  return DEPTH_KINDS.includes(kind) && process.env.NEXT_PUBLIC_SHOW_DEPTH_CHARTS !== 'true';
}
