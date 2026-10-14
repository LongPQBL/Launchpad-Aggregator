'use client';

import { useId, useState, type ReactNode } from 'react';
import { DOTTED_BACKGROUND_STYLE } from '@/components/chart-decor';
import { formatLevel } from './depth-view';
import type { CurvePoint, CurveShape } from './curve-shape';

const GREEN = '#22c55e';
const WIDTH = 600;
const HEIGHT = 320;
const AXIS = 28;
const TOP = 12;
const LEFT = 8;

function formatTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : value.toFixed(0);
}

/**
 * A bonding curve drawn as price against graduation progress: the solid, filled part is what has already been bought, the dashed
 * part is what is left until the curve graduates to its Uniswap pool.
 */
export function CurveShapeView({ shape, baseSymbol, quoteSymbol, trailing }: { shape: CurveShape; baseSymbol: string; quoteSymbol: string; trailing?: ReactNode }) {
  const gradient = useId();
  const [hover, setHover] = useState<CurvePoint | null>(null);
  const { points, current, graduation } = shape;
  const yMax = graduation.price * 1.05 || 1;
  const x = (progress: number) => LEFT + progress * (WIDTH - LEFT - 2);
  const y = (price: number) => HEIGHT - AXIS - (price / yMax) * (HEIGHT - AXIS - TOP);
  const base = HEIGHT - AXIS;
  const path = (items: readonly CurvePoint[]) => items.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.progress)},${y(point.price)}`).join(' ');
  const done = [...points.filter((point) => point.progress < current.progress), current];
  const left = points.filter((point) => point.progress > current.progress);
  const ahead = [current, ...left, graduation];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * yMax);
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, ((event.clientX - box.left) / box.width * WIDTH - LEFT) / (WIDTH - LEFT - 2)));
    setHover(points.reduce((best, point) => Math.abs(point.progress - progress) < Math.abs(best.progress - progress) ? point : best, points[0]!));
  };
  const shown = hover ?? current;
  return (
    <section aria-label="Bonding curve">
      <div className="mb-2 min-h-20" data-testid="curve-shape-readout">
        <p className="text-2xl">{formatLevel(shown.price)} {quoteSymbol}</p>
        <p className="text-sm text-muted-foreground">
          {hover ? 'At' : 'Now at'} {(shown.progress * 100).toFixed(1)}% of graduation · {formatLevel(shown.quotePaidIn)} {quoteSymbol} paid in
          {shown.tokensSold === null ? '' : ` · ${formatTokens(shown.tokensSold)} ${baseSymbol} sold`}
        </p>
      </div>
      <div className="relative rounded-lg" style={DOTTED_BACKGROUND_STYLE}>
        <svg role="img" aria-label="Bonding curve chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-80 w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={GREEN} stopOpacity="0.35" /><stop offset="1" stopColor={GREEN} stopOpacity="0" /></linearGradient>
          </defs>
          {yTicks.map((tick, index) => <g key={index}>
            <line x1={LEFT} x2={WIDTH} y1={y(tick)} y2={y(tick)} stroke="#27272a" strokeWidth="1" />
            {index > 0 && <text x={WIDTH - 2} y={y(tick) - 3} textAnchor="end" fill="#a1a1aa" fontSize="11">{formatLevel(tick)}</text>}
          </g>)}
          <path data-testid="curve-done-area" d={`${path(done)} L${x(current.progress)},${base} L${x(0)},${base} Z`} fill={`url(#${gradient})`} />
          <path data-testid="curve-done" d={path(done)} fill="none" stroke={GREEN} strokeWidth="2.5" strokeLinejoin="round" />
          <path data-testid="curve-ahead" d={path(ahead)} fill="none" stroke={GREEN} strokeWidth="2" strokeDasharray="6 5" strokeLinejoin="round" opacity="0.7" />
          <line x1={x(current.progress)} x2={x(current.progress)} y1={y(current.price)} y2={base} stroke="#52525b" strokeDasharray="3 3" />
          <circle data-testid="curve-now" cx={x(current.progress)} cy={y(current.price)} r="5" fill={GREEN} stroke="#0a0a0b" strokeWidth="2" />
          <circle data-testid="curve-graduation" cx={x(1)} cy={y(graduation.price)} r="4" fill="#0a0a0b" stroke={GREEN} strokeWidth="2" />
          <text x={x(1) - 8} y={Math.max(14, y(graduation.price) - 8)} textAnchor="end" fill="#a1a1aa" fontSize="11">Graduates · {formatLevel(graduation.price)}</text>
          {hover && <><line x1={x(hover.progress)} x2={x(hover.progress)} y1={TOP} y2={base} stroke="#52525b" strokeDasharray="3 3" /><circle cx={x(hover.progress)} cy={y(hover.price)} r="4" fill={GREEN} stroke="#0a0a0b" strokeWidth="2" /></>}
          {[0, 0.25, 0.5, 0.75, 1].map((tick, index) => <text key={tick} x={Math.min(WIDTH - 2, Math.max(2, x(tick)))} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'} fill="#a1a1aa" fontSize="11">{tick * 100}%</text>)}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{trailing}</div>
    </section>
  );
}
