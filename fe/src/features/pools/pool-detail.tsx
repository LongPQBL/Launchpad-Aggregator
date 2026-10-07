import { launchHref, poolHref, type PoolCandlePage, type PoolSummary, type PoolTradePage } from '@/api/client';
import { chainExplorerBase, chainName } from '@/api/chains';
import { formatPercent, formatPrice, formatUsd } from '@/api/format';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { SwapPanel } from '@/trading/swap-panel';
import { V4SwapPanel } from '@/trading/v4-swap-panel';
import { PoolChart } from './pool-chart';
import { PoolLogo } from './pool-logo';
import { poolAge, short as symbol } from './pool-list';

export function PoolDetail({ pool, trades, candles }: { pool: PoolSummary; trades: PoolTradePage | null; candles: PoolCandlePage | null }) {
  const other = pool.displayedToken === pool.currency0 ? pool.currency1 : pool.currency0;
  const otherSymbol = pool.displayedToken === pool.currency0 ? pool.currency1Symbol : pool.currency0Symbol;
  const quote = otherSymbol ?? symbol(other);
  const explorerBase = chainExplorerBase(pool.chainId);
  return <article className="space-y-4">
    <Link href="/pools" className="text-sm underline">← Pools</Link>
    <Card><CardHeader className="flex-row items-center gap-3">
      <PoolLogo
        token0={{ symbol: pool.currency0Symbol ?? symbol(pool.currency0), logoUri: pool.currency0LogoUri }}
        token1={{ symbol: pool.currency1Symbol ?? symbol(pool.currency1), logoUri: pool.currency1LogoUri }}
        chainId={pool.chainId}
      />
      <div>
        <h1 className="text-2xl font-semibold">{pool.currency0Symbol ?? symbol(pool.currency0)} / {pool.currency1Symbol ?? symbol(pool.currency1)}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted-foreground">{chainName(pool.chainId)}</span>
          <Badge variant="secondary">{`${pool.protocol.replace('uniswap_', '')} · ${pool.fee / 10_000}%`}</Badge>
          {pool.ponsDesignated && <span className="text-sm">Pons designated pool</span>}
        </div>
      </div>
    </CardHeader>
      <CardContent className="space-y-4"><div className="flex flex-wrap gap-2">
        <a className="rounded border px-3 py-1" aria-current={pool.displayedToken === pool.currency0 ? 'page' : undefined}
          href={poolHref(pool, pool.currency0)}>View {pool.currency0Symbol ?? symbol(pool.currency0)}</a>
        <a className="rounded border px-3 py-1" aria-current={pool.displayedToken === pool.currency1 ? 'page' : undefined}
          href={poolHref(pool, pool.currency1)}>View {pool.currency1Symbol ?? symbol(pool.currency1)}</a></div>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div><dt>Price in {quote}</dt><dd>{formatPrice(pool.priceInQuote, quote)}</dd></div>
        <div><dt>Price USD</dt><dd>{formatUsd(pool.priceUsd, 1)}</dd></div>
        <div><dt>24h volume USD</dt><dd>{formatUsd(pool.volume24hUsd, 1)}</dd></div>
        <div><dt>Liquidity USD</dt><dd>{formatUsd(pool.tvlUsd, 1)}</dd></div>
        <div><dt>FDV (pool price)</dt><dd>{formatUsd(pool.fdvUsd, 1)}</dd></div>
        <div><dt>1h change</dt><dd className={cn(formatPercent(pool.change1h).className)}>{formatPercent(pool.change1h).text}</dd></div>
        <div><dt>1d change</dt><dd className={cn(formatPercent(pool.change1d).className)}>{formatPercent(pool.change1d).text}</dd></div>
        <div><dt>Coverage</dt><dd>{pool.coverageStatus.replace('_', ' ')}</dd></div>
        <div><dt>Fee</dt><dd>{pool.fee / 10_000}%</dd></div>
        {pool.protocol !== 'uniswap_v2' && <div><dt>Tick spacing</dt><dd>{pool.tickSpacing}</dd></div>}
        {pool.protocol === 'uniswap_v4' && <div><dt>Hook</dt><dd className="break-all font-mono">{pool.hooks}</dd></div>}
        <div><dt>Created block</dt><dd>{pool.createdBlock}</dd></div>
        <div><dt>Age</dt><dd>{poolAge(pool.createdTimestamp)}</dd></div>
        <div><dt>Last trade</dt><dd>{pool.lastTradeTimestamp === null ? '—' : new Date(pool.lastTradeTimestamp * 1000).toLocaleString('en-US')}</dd></div>
      </dl>{pool.launchTokenAddress && <a className="underline" href={launchHref(pool.chainId, pool.launchTokenAddress)}>View Pons launch</a>}
      </CardContent></Card>
    {/* Swap execution uses SwapRouter02's exactInputSingle for V3 pools and Universal Router's
        V4_SWAP/PERMIT2_PERMIT commands for V4 pools (its shared PoolManager has no per-pool
        router). Hidden, never guessed, when either currency's decimals is unknown (same
        convention as launch-detail.tsx's own SwapPanel gate). */}
    {pool.protocol === 'uniswap_v3' && pool.currency0Decimals !== null && pool.currency1Decimals !== null && (
      <Card><CardContent className="pt-6">
        <SwapPanel
          poolAddress={pool.poolId as `0x${string}`}
          tokenA={{ address: pool.currency0 as `0x${string}`, symbol: pool.currency0Symbol, decimals: pool.currency0Decimals, logoUri: pool.currency0LogoUri }}
          tokenB={{ address: pool.currency1 as `0x${string}`, symbol: pool.currency1Symbol, decimals: pool.currency1Decimals, logoUri: pool.currency1LogoUri }}
          explorerBase={explorerBase ?? null}
        />
      </CardContent></Card>
    )}
    {pool.protocol === 'uniswap_v4' && pool.currency0Decimals !== null && pool.currency1Decimals !== null && (
      <Card><CardContent className="pt-6">
        <V4SwapPanel
          poolKey={{ currency0: pool.currency0 as `0x${string}`, currency1: pool.currency1 as `0x${string}`,
            fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks as `0x${string}` }}
          tokenA={{ address: pool.currency0 as `0x${string}`, symbol: pool.currency0Symbol, decimals: pool.currency0Decimals }}
          tokenB={{ address: pool.currency1 as `0x${string}`, symbol: pool.currency1Symbol, decimals: pool.currency1Decimals }}
          explorerBase={explorerBase ?? null}
        />
      </CardContent></Card>
    )}
    {candles && <PoolChart candles={candles} coverageStatus={pool.coverageStatus} quoteSymbol={quote} />}
    <Card><CardHeader><h2 className="font-semibold">Pool trades</h2></CardHeader><CardContent>
      {trades ? <><div className="space-y-2 text-sm">{trades.items.map((trade) => <p key={`${trade.txHash}:${trade.logIndex}`}>
        {new Date(trade.timestamp * 1000).toLocaleString('en-US')} · {trade.side} · {formatUsd(trade.usdValue, 2)} · {trade.usdValueStatus}
      </p>)}</div>{trades.nextCursor && <a className="mt-3 block underline" href={`${poolHref(pool, pool.displayedToken)}&cursor=${encodeURIComponent(trades.nextCursor)}`}>Next trades</a>}</>
        : <p role="status">Could not load pool trades.</p>}</CardContent></Card>
  </article>;
}
