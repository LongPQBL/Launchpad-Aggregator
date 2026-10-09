import { poolHref, type PoolCandlePage, type PoolHistory, type PoolSummary, type PoolTradePage } from '@/api/client';
import { chainExplorerBase, chainIcon, chainName } from '@/api/chains';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Image from 'next/image';
import Link from 'next/link';
import { CopyableTokenAddress } from '@/features/launch/copyable-token-address';
import { PoolChart } from './pool-chart';
import { PoolHistoryChart } from './pool-history-chart';
import { PoolLogo } from './pool-logo';
import { PoolStats } from './pool-stats';
import { PoolLinks } from './pool-links';
import { PoolTransactionList } from './pool-transaction-list';
import { SwapTrigger } from './swap-trigger';
import { short as symbol } from './pool-format';

export function PoolDetail({ pool, trades, candles, history = null }: { pool: PoolSummary; trades: PoolTradePage | null; candles: PoolCandlePage | null; history?: PoolHistory | null }) {
  const displayedIsCurrency0 = pool.displayedToken === pool.currency0;
  const other = displayedIsCurrency0 ? pool.currency1 : pool.currency0;
  const otherSymbol = displayedIsCurrency0 ? pool.currency1Symbol : pool.currency0Symbol;
  const otherLogoUri = displayedIsCurrency0 ? pool.currency1LogoUri : pool.currency0LogoUri;
  const displayedSymbol = displayedIsCurrency0 ? pool.currency0Symbol : pool.currency1Symbol;
  const displayedLogoUri = displayedIsCurrency0 ? pool.currency0LogoUri : pool.currency1LogoUri;
  const displayedDecimals = displayedIsCurrency0 ? pool.currency0Decimals : pool.currency1Decimals;
  const otherDecimals = displayedIsCurrency0 ? pool.currency1Decimals : pool.currency0Decimals;
  const quote = otherSymbol ?? symbol(other);
  const explorerBase = chainExplorerBase(pool.chainId);
  // Both the title and the logo stack follow displayedToken's order (not always currency0/
  // currency1) so the Flip link swaps which token reads first and which logo sits in front,
  // together — never one without the other.
  const pairLabel = `${displayedSymbol ?? symbol(pool.displayedToken)} / ${quote}`;
  const icon = chainIcon(pool.chainId);
  return <article className="space-y-4">
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-base text-muted-foreground">
      <Link href="/pools">Pools</Link>
      <span aria-hidden="true">›</span>
      <span className="font-medium text-foreground">{pairLabel}</span>
    </nav>
    <Card className="border-0 bg-transparent"><CardHeader className="flex-row items-center gap-3">
      <PoolLogo
        token0={{ symbol: displayedSymbol ?? symbol(pool.displayedToken), logoUri: displayedLogoUri }}
        token1={{ symbol: otherSymbol ?? symbol(other), logoUri: otherLogoUri }}
        chainId={pool.chainId}
      />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {pairLabel}
          <Link href={poolHref(pool, other)} aria-label="Flip token order" className="text-muted-foreground hover:text-foreground">
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" className="shrink-0">
              <path d="M4 3v8.5M4 11.5 1.5 9M4 11.5 6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 13V4.5M12 4.5 9.5 7M12 4.5 14.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {icon && <Image src={icon} alt="" width={14} height={14} unoptimized className="h-3.5 w-3.5 rounded-full" />}
          <span>{chainName(pool.chainId)}</span>
          <Badge variant="secondary">{pool.protocol.replace('uniswap_', '')}</Badge>
          <Badge variant="secondary">{pool.fee / 10_000}%</Badge>
          <CopyableTokenAddress address={pool.poolId} />
          {pool.ponsDesignated && <span>Pons designated pool</span>}
        </div>
      </div>
    </CardHeader></Card>

    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
      <div className="flex flex-col gap-4">
        {candles && <PoolChart pool={pool} candles={candles} coverageStatus={pool.coverageStatus} quoteSymbol={quote} tokenSymbol={displayedSymbol} />}
        {history && <PoolHistoryChart items={history.items} complete={history.complete} />}
        <section aria-labelledby="pool-transactions-heading" className="space-y-3">
          <h2 id="pool-transactions-heading" className="text-2xl font-semibold">Transactions</h2>
          {trades ? <>
            <PoolTransactionList
              trades={trades.items}
              displayedSymbol={displayedSymbol}
              otherSymbol={otherSymbol}
              displayedDecimals={displayedDecimals}
              otherDecimals={otherDecimals}
              displayedIsCurrency0={displayedIsCurrency0}
              explorerBase={explorerBase ?? null}
            />
            {trades.nextCursor && <Link className="mt-3 block" href={`${poolHref(pool, pool.displayedToken)}&cursor=${encodeURIComponent(trades.nextCursor)}`}>Next trades</Link>}
          </>
            : <p role="status">Could not load pool trades.</p>}
        </section>
      </div>

      <div className="flex flex-col gap-4">
        {/* Swap execution uses Universal Router + Permit2 for both: V3_SWAP_EXACT_IN/PERMIT2_PERMIT
            commands for V3 pools, V4_SWAP/PERMIT2_PERMIT commands for V4 pools (its shared
            PoolManager has no per-pool router). Hidden, never guessed, when either currency's
            decimals is unknown (same convention as launch-detail.tsx's own SwapPanel gate). */}
        {pool.currency0Decimals !== null && pool.currency1Decimals !== null && (
          <SwapTrigger
            protocol={pool.protocol as 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'}
            poolId={pool.poolId as `0x${string}`}
            tokenA={{ address: pool.currency0 as `0x${string}`, symbol: pool.currency0Symbol, decimals: pool.currency0Decimals, logoUri: pool.currency0LogoUri }}
            tokenB={{ address: pool.currency1 as `0x${string}`, symbol: pool.currency1Symbol, decimals: pool.currency1Decimals, logoUri: pool.currency1LogoUri }}
            fee={pool.fee}
            tickSpacing={pool.tickSpacing}
            hooks={pool.hooks as `0x${string}`}
            explorerBase={explorerBase ?? null}
            targetChainName={chainName(pool.chainId)}
          />
        )}
        <PoolStats
          protocol={pool.protocol}
          poolAddress={pool.poolId as `0x${string}`}
          fee={pool.fee}
          tvlUsd={pool.tvlUsd}
          volume24hUsd={pool.volume24hUsd}
          volume24hChange={pool.volume24hChange}
          tvlChange={pool.tvlChange}
          createdTimestamp={pool.createdTimestamp}
          priceInQuote={pool.priceInQuote}
          poolBalances={pool.poolBalances}
          displayed={{ address: pool.displayedToken as `0x${string}`, symbol: displayedSymbol, decimals: displayedDecimals }}
          other={{ address: other as `0x${string}`, symbol: otherSymbol, decimals: otherDecimals }}
        />
        <PoolLinks pool={pool} />
      </div>
    </div>
  </article>;
}
