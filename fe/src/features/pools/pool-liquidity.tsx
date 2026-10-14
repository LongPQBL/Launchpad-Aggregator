'use client';

import { useState, type ReactNode } from 'react';
import { getCurveDepth, getPoolLiquidity, type PoolLiquidity, type PoolSummary } from '@/api/client';
import { displaySymbol } from '@/api/format';
import { DOTTED_BACKGROUND_STYLE } from '@/components/chart-decor';
import { DepthView, formatLevel } from '@/features/chart/depth-view';
import { LAUNCH_CHANGED_EVENT, POOL_CHANGED_EVENT, TRADE_CREATED_EVENT } from '@/hooks/live-events';
import { useLoaded } from '@/hooks/use-loaded';

const UNAVAILABLE: Record<string, string> = {
  read_failed: 'Could not read this liquidity from the chain right now.',
  too_many_ticks: 'This pool has too many price ranges to display.',
  decimals_unavailable: 'Token decimals are unavailable, so no chart can be drawn.',
  accounting_unverified: 'This pool\'s hook manages liquidity in its own way, so a chart would be misleading.',
  liquidity_mismatch: 'The on-chain price ranges do not add up to the pool\'s liquidity, so no chart is shown.',
  graduated: 'This curve has graduated; see the pool.',
};
const unavailableText = (reason: string | null) => (reason !== null ? UNAVAILABLE[reason] ?? 'Not available.' : null);

function Message({ children, role = 'status', trailing }: { children: ReactNode; role?: 'status' | 'alert'; trailing?: ReactNode }) {
  return <div><p role={role} className="flex h-80 items-center justify-center text-center text-sm text-muted-foreground">{children}</p><div className="mt-2 flex justify-end">{trailing}</div></div>;
}

/** Raw liquidity units are huge (1e18 and up): below a trillion in plain compact form, above it in scientific notation. */
export function formatLiquidity(value: number): string {
  return value >= 1e12 ? value.toExponential(2) : Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 }).format(value);
}

const BINS = 80;
const WIDTH = 600;
const HEIGHT = 300;
const AXIS = 24;

/** Liquidity per price range around the current price: one bar per slice of at most ~1% of price, the active range brighter. */
export function LiquidityBars({ data, symbols }: { data: PoolLiquidity; symbols: { token0: string; token1: string } }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const step = Math.max(1, Math.min(data.tickSpacing, 100));
  const current = data.currentTick ?? 0;
  const start = Math.floor(current / step) * step - (BINS / 2) * step;
  const decimals0 = data.token0.decimals ?? 18;
  const decimals1 = data.token1.decimals ?? 18;
  const tickPrice = (tick: number) => 1.0001 ** tick * 10 ** (decimals0 - decimals1);
  const bins = Array.from({ length: BINS }, (_, index) => {
    const tick = start + index * step;
    const range = data.ranges.find((candidate) => candidate.tickLower <= tick && tick < candidate.tickUpper);
    return { tick, range, liquidity: range ? Number(range.liquidity) : 0 };
  });
  const biggest = Math.max(1, ...bins.map((bin) => bin.liquidity));
  const barWidth = WIDTH / BINS;
  const base = HEIGHT - AXIS;
  const marker = ((current - start) / step) * barWidth;
  const shown = hovered === null ? null : bins[hovered]!;
  return (
    <div className="relative rounded-lg" style={DOTTED_BACKGROUND_STYLE}>
      <svg role="img" aria-label={`Liquidity of ${symbols.token0} / ${symbols.token1}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-80 w-full" onMouseLeave={() => setHovered(null)}>
        {bins.map((bin, index) => bin.liquidity > 0 && (
          <rect key={bin.tick} data-testid="liquidity-bar" data-active={bin.range?.active ? 'true' : 'false'} x={index * barWidth + 0.5} width={barWidth - 1}
            y={base - (bin.liquidity / biggest) * (base - 8)} height={(bin.liquidity / biggest) * (base - 8)} rx="1.5"
            fill={bin.range?.active ? '#22c55e' : 'rgba(34, 197, 94, 0.35)'} opacity={hovered === null || hovered === index ? 1 : 0.7} />
        ))}
        {bins.map((bin, index) => <rect key={`hit-${bin.tick}`} x={index * barWidth} width={barWidth} y="0" height={base} fill="transparent" onMouseEnter={() => setHovered(index)} />)}
        <line data-testid="liquidity-current" x1={marker} x2={marker} y1="0" y2={base} stroke="#a1a1aa" strokeDasharray="4 3" />
        {[0, 1, 2, 3, 4].map((tickIndex) => {
          const at = Math.round((tickIndex * (BINS - 1)) / 4);
          return <text key={tickIndex} x={Math.min(WIDTH - 2, Math.max(2, at * barWidth))} y={HEIGHT - 6} textAnchor={tickIndex === 0 ? 'start' : tickIndex === 4 ? 'end' : 'middle'} fill="#a1a1aa" fontSize="11">{formatLevel(tickPrice(bins[at]!.tick))}</text>;
        })}
      </svg>
      {shown && shown.range && <div role="status" data-testid="liquidity-hover" className="pointer-events-none absolute right-3 top-3 rounded-md border border-border bg-background/95 px-2 py-1 text-xs">
        <div>{formatLevel(shown.range.priceLower)} – {formatLevel(shown.range.priceUpper)} {symbols.token1}</div>
        <div className="text-muted-foreground">Liquidity {formatLiquidity(shown.liquidity)}</div>
      </div>}
    </div>
  );
}

type PoolRef = Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'currency0Symbol' | 'currency1Symbol'>;
// A swap in this pool moves the price the chart shows; the API drops its cached read when it announces the swap.
// These reads cost the API dozens of RPC calls, so it limits them to 20 a minute per client: refetch at most every 4 s (15 a minute).
const RPC_BACKED_MIN_INTERVAL_MS = 4_000;
const poolLive = (pool: PoolRef) => ({
  eventName: POOL_CHANGED_EVENT,
  minIntervalMs: RPC_BACKED_MIN_INTERVAL_MS,
  matches: (payload: { chainId: number; poolId?: string }) => payload.chainId === pool.chainId && payload.poolId === pool.poolId.toLowerCase(),
});
const poolSymbols = (pool: PoolRef) => ({ token0: displaySymbol(pool.currency0Symbol ?? null), token1: displaySymbol(pool.currency1Symbol ?? null) });

/** The Liquidity tab of a V3 / V4 pool. */
export function PoolLiquidityChart({ pool, trailing }: { pool: PoolRef; trailing?: ReactNode }) {
  const loaded = useLoaded(() => getPoolLiquidity(pool), [pool.chainId, pool.protocol, pool.poolId], poolLive(pool));
  const symbols = poolSymbols(pool);
  if (loaded.status === 'loading') return <div role="status" aria-label="Loading liquidity" className="h-80 w-full animate-pulse rounded-lg bg-muted" />;
  if (loaded.status === 'error') return <Message role="alert" trailing={trailing}>Could not load this pool&apos;s liquidity.</Message>;
  const data = loaded.data;
  if (!data.complete) return <Message trailing={trailing}>{unavailableText(data.unavailableReason)}</Message>;
  if (data.ranges.length === 0 || data.price === null) return <Message trailing={trailing}>This pool has no liquidity right now.</Message>;
  return (
    <section aria-label="Liquidity">
      <div className="mb-2 min-h-20" data-testid="liquidity-readout">
        <p className="text-2xl">1 {symbols.token0} = {formatLevel(data.price)} {symbols.token1}</p>
        <p className="text-sm text-muted-foreground">1 {symbols.token1} = {formatLevel(data.priceInverse ?? 0)} {symbols.token0} · Active price range</p>
      </div>
      <LiquidityBars data={data} symbols={symbols} />
      <div className="mt-2 flex justify-end">{trailing}</div>
    </section>
  );
}

/** The Depth tab of a V3 / V4 pool: the order-book view of its liquidity (token0 is the base, token1 the quote). */
export function PoolDepthChart({ pool, trailing }: { pool: PoolRef & { fee?: number }; trailing?: ReactNode }) {
  const loaded = useLoaded(() => getPoolLiquidity(pool), [pool.chainId, pool.protocol, pool.poolId], poolLive(pool));
  const symbols = poolSymbols(pool);
  if (loaded.status === 'loading') return <div role="status" aria-label="Loading depth" className="h-80 w-full animate-pulse rounded-lg bg-muted" />;
  if (loaded.status === 'error') return <Message role="alert" trailing={trailing}>Could not load this pool&apos;s depth.</Message>;
  const data = loaded.data;
  if (!data.complete || !data.depth || data.price === null) return <Message trailing={trailing}>{unavailableText(data.unavailableReason)}</Message>;
  const spread = data.depth.spreadPercent;
  return (
    <div>
      <div className="mb-2 min-h-20"><p className="text-2xl">1 {symbols.token0} = {formatLevel(data.price)} {symbols.token1}</p></div>
      <DepthView depth={data.depth} price={data.price} baseSymbol={symbols.token0} quoteSymbol={symbols.token1} trailing={trailing}
        spreadLabel={`Spread ${spread === null ? '—' : formatLevel(spread)}% (Fee tier ${formatLevel(data.feePips / 10_000)}%)`} />
    </div>
  );
}

/** The Depth tab of a bonding-curve page: the curve's constant-product depth, bounded by graduation above and by the paid-in reserve below. */
export function CurveDepthChart({ chainId, tokenAddress, baseSymbol, quoteSymbol, trailing }: {
  chainId: number; tokenAddress: string; baseSymbol: string; quoteSymbol: string; trailing?: ReactNode;
}) {
  // A trade of the launch moves the curve's reserves (trade.created), and the API announces launch.changed once it has recomputed.
  const loaded = useLoaded(() => getCurveDepth(chainId, tokenAddress), [chainId, tokenAddress], {
    eventName: [TRADE_CREATED_EVENT, LAUNCH_CHANGED_EVENT],
    minIntervalMs: RPC_BACKED_MIN_INTERVAL_MS,
    matches: (payload) => payload.chainId === chainId && payload.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase(),
  });
  if (loaded.status === 'loading') return <div role="status" aria-label="Loading depth" className="h-80 w-full animate-pulse rounded-lg bg-muted" />;
  if (loaded.status === 'error') return <Message role="alert" trailing={trailing}>Could not load the curve&apos;s depth.</Message>;
  const data = loaded.data;
  if (data === null) return <Message trailing={trailing}>This launch has no bonding curve.</Message>;
  if (!data.complete || !data.depth || data.price === null) return <Message trailing={trailing}>{unavailableText(data.unavailableReason)}</Message>;
  const notes = ['Amounts exclude the creator tax and snipe protection.'];
  if (data.asksEndAtGraduation) notes.push('Buying beyond the last row graduates the curve.');
  if (data.depth.bids.length === 0) notes.push('Nobody has bought from this curve yet, so there is nothing to sell into.');
  else if (data.bidsEndAtEmptyReserve) notes.push('The curve can only pay out what has been paid in, so there are no sells beyond the last row.');
  const fee = data.feeBps === null ? '—' : formatLevel(data.feeBps / 100);
  return (
    <div>
      <div className="mb-2 min-h-20"><p className="text-2xl">1 {baseSymbol} = {formatLevel(data.price)} {quoteSymbol}</p></div>
      <DepthView depth={data.depth} price={data.price} baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} notes={notes} trailing={trailing}
        spreadLabel={`Spread ${data.depth.spreadPercent === null ? '—' : formatLevel(data.depth.spreadPercent)}% (Fee ${fee}%)`} />
    </div>
  );
}
