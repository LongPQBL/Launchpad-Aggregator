'use client';

import { useState, type ReactNode } from 'react';
import { DOTTED_BACKGROUND_STYLE } from '@/components/chart-decor';
import type { DepthData } from '@/api/client';

const ASK = '#ef4444';
const BID = '#22c55e';
const WIDTH = 600;
const HEIGHT = 320;
const AXIS = 28;

/** A level (price or amount) with 3 significant digits below 1, 2 decimals up to 1,000 and none above. */
export function formatLevel(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 0 : 2 });
  return value.toFixed(Math.min(20, -Math.floor(Math.log10(value)) + 2)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const ZOOMS = [0.25, 0.5, 1] as const;

function DepthChart({ depth, price }: { depth: DepthData; price: number }) {
  const [zoom, setZoom] = useState<number>(1);
  const [hover, setHover] = useState<{ x: number; price: number; cumulative: number; side: 'ask' | 'bid' } | null>(null);
  const keep = <T,>(rows: readonly T[]) => rows.slice(0, Math.max(1, Math.ceil(rows.length * zoom)));
  const asks = keep(depth.asks);
  const bids = keep(depth.bids);
  const xMin = bids.length > 0 ? bids[bids.length - 1]!.price : price;
  const xMax = asks.length > 0 ? asks[asks.length - 1]!.price : price;
  const yMax = Math.max(asks.at(-1)?.cumulative1 ?? 0, bids.at(-1)?.cumulative1 ?? 0) * 1.05 || 1;
  const x = (value: number) => (xMax === xMin ? WIDTH / 2 : ((value - xMin) / (xMax - xMin)) * WIDTH);
  const y = (value: number) => HEIGHT - AXIS - (value / yMax) * (HEIGHT - AXIS - 8);
  const base = HEIGHT - AXIS;
  const area = (rows: readonly { price: number; cumulative1: number }[]) =>
    rows.length === 0 ? '' : `M${x(price)},${base} ${rows.map((row) => `L${x(row.price)},${y(row.cumulative1)}`).join(' ')} L${x(rows.at(-1)!.price)},${base} Z`;
  const line = (rows: readonly { price: number; cumulative1: number }[]) =>
    rows.length === 0 ? '' : `M${x(price)},${base} ${rows.map((row) => `L${x(row.price)},${y(row.cumulative1)}`).join(' ')}`;
  const ticks = Array.from({ length: 5 }, (_, index) => xMin + ((xMax - xMin) * index) / 4);
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = xMin + ((event.clientX - box.left) / box.width) * (xMax - xMin);
    const side = at >= price ? 'ask' : 'bid';
    const rows = side === 'ask' ? asks : bids;
    const nearest = rows.reduce<typeof rows[number] | null>((best, row) => (best === null || Math.abs(row.price - at) < Math.abs(best.price - at) ? row : best), null);
    setHover(nearest ? { x: x(nearest.price), price: nearest.price, cumulative: nearest.cumulative1, side } : null);
  };
  const zoomBy = (direction: 1 | -1) => setZoom((current) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(current as 0.25) + direction))]!);
  const button = 'flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground hover:text-foreground';
  return (
    <div>
      <div className="relative rounded-lg" style={DOTTED_BACKGROUND_STYLE}>
        <svg role="img" aria-label="Depth chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-80 w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="depth-bid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={BID} stopOpacity="0.35" /><stop offset="1" stopColor={BID} stopOpacity="0" /></linearGradient>
            <linearGradient id="depth-ask" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={ASK} stopOpacity="0.35" /><stop offset="1" stopColor={ASK} stopOpacity="0" /></linearGradient>
          </defs>
          <path data-testid="depth-bids-area" d={area(bids)} fill="url(#depth-bid)" />
          <path data-testid="depth-asks-area" d={area(asks)} fill="url(#depth-ask)" />
          <path data-testid="depth-bids" data-rows={bids.length} d={line(bids)} fill="none" stroke={BID} strokeWidth="2" strokeLinejoin="round" />
          <path data-testid="depth-asks" data-rows={asks.length} d={line(asks)} fill="none" stroke={ASK} strokeWidth="2" strokeLinejoin="round" />
          <line x1={x(price)} x2={x(price)} y1="0" y2={base} stroke="#52525b" strokeWidth="1" />
          {hover && <><line x1={hover.x} x2={hover.x} y1="0" y2={base} stroke="#52525b" strokeDasharray="3 3" /><circle cx={hover.x} cy={y(hover.cumulative)} r="4" fill={hover.side === 'ask' ? ASK : BID} stroke="#0a0a0b" strokeWidth="2" /></>}
          {ticks.map((tick, index) => <text key={index} x={Math.min(WIDTH - 2, Math.max(2, x(tick)))} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'} fill="#a1a1aa" fontSize="11">{formatLevel(tick)}</text>)}
        </svg>
        {hover && <div role="status" data-testid="depth-hover" className="pointer-events-none absolute right-3 top-3 rounded-md border border-border bg-background/95 px-2 py-1 text-xs">
          <div>Price {formatLevel(hover.price)}</div><div className="text-muted-foreground">Total {formatLevel(hover.cumulative)}</div>
        </div>}
      </div>
      <div className="mt-2 flex justify-end gap-2" role="group" aria-label="Depth zoom">
        <button type="button" aria-label="Zoom out" className={button} onClick={() => zoomBy(1)}>−</button>
        <button type="button" aria-label="Fit to chart" className={button} onClick={() => setZoom(1)}>⤢</button>
        <button type="button" aria-label="Zoom in" className={button} onClick={() => zoomBy(-1)}>+</button>
      </div>
    </div>
  );
}

function DepthTable({ depth, baseSymbol, quoteSymbol, spreadLabel }: { depth: DepthData; baseSymbol: string; quoteSymbol: string; spreadLabel: string }) {
  const asks = depth.asks.slice(0, 12).slice().reverse(); // farthest ask on top, nearest next to the spread
  const bids = depth.bids.slice(0, 12);
  const biggest = Math.max(1e-300, ...asks.map((row) => row.total1), ...bids.map((row) => row.total1));
  const row = (item: { price: number; amount0: number; total1: number }, side: 'ask' | 'bid') => (
    <tr key={`${side}-${item.price}`} data-testid={`depth-${side}-row`} className="relative">
      <td className="px-2 py-1" style={{ color: side === 'ask' ? ASK : BID }}>{formatLevel(item.price)}</td>
      <td className="px-2 py-1 text-right">{formatLevel(item.amount0)}</td>
      <td className="relative px-2 py-1 text-right"><span aria-hidden="true" className="absolute inset-y-0 right-0" style={{ width: `${Math.max(2, (item.total1 / biggest) * 100)}%`, background: side === 'ask' ? 'rgba(239,68,68,0.18)' : 'rgba(34,197,94,0.18)' }} /><span className="relative">{formatLevel(item.total1)}</span></td>
    </tr>
  );
  return (
    <div className="max-h-96 overflow-y-auto rounded-lg border border-border text-xs">
      <table className="w-full">
        <thead><tr className="text-muted-foreground"><th className="px-2 py-1 text-left font-normal">Price ({quoteSymbol})</th><th className="px-2 py-1 text-right font-normal">Amount ({baseSymbol})</th><th className="px-2 py-1 text-right font-normal">Total ({quoteSymbol})</th></tr></thead>
        <tbody>
          {asks.map((item) => row(item, 'ask'))}
          <tr data-testid="depth-spread"><td colSpan={3} className="border-y border-border px-2 py-1.5 text-muted-foreground">{spreadLabel}</td></tr>
          {bids.map((item) => row(item, 'bid'))}
        </tbody>
      </table>
    </div>
  );
}

/** The order-book view of a pool or a bonding curve: the cumulative chart and the price table, with notes under them. */
export function DepthView({ depth, price, baseSymbol, quoteSymbol, spreadLabel, notes = [], trailing }: {
  depth: DepthData; price: number; baseSymbol: string; quoteSymbol: string; spreadLabel: string; notes?: readonly string[]; trailing?: ReactNode;
}) {
  if (depth.asks.length === 0 && depth.bids.length === 0) {
    return <div><p role="status" className="flex h-80 items-center justify-center text-center text-sm text-muted-foreground">No liquidity to show yet.</p><div className="mt-2 flex justify-end">{trailing}</div></div>;
  }
  return (
    <section aria-label="Depth">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_270px]">
        <DepthChart depth={depth} price={price} />
        <DepthTable depth={depth} baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} spreadLabel={spreadLabel} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{trailing}</div>
      {notes.map((note) => <p key={note} className="mt-2 text-xs text-muted-foreground">{note}</p>)}
    </section>
  );
}
