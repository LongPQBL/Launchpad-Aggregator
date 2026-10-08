'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { chainName } from '@/api/chains';
import { formatPercent } from '@/api/format';
import { getLaunchPools, getPools, poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PoolLogo, type PoolLogoToken } from './pool-logo';
import { cn } from '@/lib/utils';
import { formatPoolUsd, poolAge, short } from './pool-format';

function side(address: string): string { return address.toLowerCase(); }

export interface PoolListDisplayedToken { address: string; symbol: string; logoUri: string | null }

// currencyXSymbol/currencyXLogoUri come from the backend's token-metadata resolver (RPC name/
// symbol + Robinhood asset-directory logo for non-Pons tokens); when one side is the launch token
// whose page this list is embedded in, prefer the caller's own already-known metadata over a fresh
// resolver round trip for the exact same address.
function poolLogoToken(pool: PoolSummary, address: string, apiSymbol: string | null, apiLogoUri: string | null,
  displayedToken?: PoolListDisplayedToken): PoolLogoToken {
  if (displayedToken && side(address) === side(displayedToken.address)) {
    return { symbol: displayedToken.symbol, logoUri: displayedToken.logoUri };
  }
  return { symbol: apiSymbol ?? short(address), logoUri: apiLogoUri };
}
function pairLabel(pool: PoolSummary, displayedToken?: PoolListDisplayedToken): string {
  const label = (address: string, symbol: string | null) =>
    displayedToken && side(address) === side(displayedToken.address) ? displayedToken.symbol : (symbol ?? short(address));
  return `${label(pool.currency0, pool.currency0Symbol)} / ${label(pool.currency1, pool.currency1Symbol)}`;
}
export function PoolList({ page, error = false, tokenAddress, chainId, displayedToken }: {
  page: PoolPage | null; error?: boolean; tokenAddress?: string; chainId?: number;
  displayedToken?: PoolListDisplayedToken;
}) {
  const [items, setItems] = useState<readonly PoolSummary[]>(page?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(page?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    setItems(page?.items ?? []);
    setNextCursor(page?.nextCursor ?? null);
    setLoadError(false);
  }, [page]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current || (tokenAddress && chainId === undefined)) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const nextPage = tokenAddress
        ? await getLaunchPools(chainId!, tokenAddress, { cursor: nextCursor, excludeOfficial: true })
        : await getPools({ cursor: nextCursor, chainId });
      setItems((current) => [...current, ...nextPage.items]);
      setNextCursor(nextPage.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [chainId, nextCursor, tokenAddress]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || loadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadError, loadMore, nextCursor]);

  if (error || !page) return <p role="alert">Could not load pools. Please try again.</p>;
  return <section aria-label={tokenAddress ? 'Other pools for this token' : 'Pools'} className="space-y-4">
    {!tokenAddress && <div><h1 className="text-2xl font-semibold">Pools</h1>
      <p className="text-sm text-muted-foreground">Verified indexed Uniswap pools on Robinhood Chain. Supported sources: {page.supportedProtocols.map((p) => p.replace('uniswap_', '')).join(', ')}.</p></div>}
    {items.length === 0 && <p>No verified indexed pools found.</p>}
    {tokenAddress ? <div role="table" aria-label="Pools for this token" className="w-full overflow-hidden rounded-lg border border-border md:table md:border-separate md:border-spacing-0">
      <div role="rowgroup" className="hidden bg-muted md:table-header-group">
        <div role="row" className="md:table-row">
          {['#', 'Pool', 'FDV', '24H volume', 'Liquidity', '1H', '1D', 'Age'].map((label, index) => <div key={label} role="columnheader" className={cn('text-muted-foreground md:table-cell md:h-10 md:px-4 md:align-middle md:text-xs md:font-medium md:uppercase md:tracking-wide', index > 1 && 'md:text-right')}>{label}</div>)}
        </div>
      </div>
      <div role="rowgroup" className="flex flex-col gap-3 p-3 md:table-row-group md:gap-0 md:p-0">
        {items.map((pool, index) => <div key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`} role="row" className="group relative cursor-pointer rounded-lg border border-border bg-card p-3 md:table-row md:rounded-none md:border-0 md:border-b md:border-border md:bg-transparent md:p-0 md:transition-colors md:hover:bg-muted/60">
          <div role="cell" className="pointer-events-none text-foreground md:table-cell md:p-4 md:align-middle">
            <a href={poolHref(pool, tokenAddress)} aria-label={`View pool ${pairLabel(pool, displayedToken)}`} className="pointer-events-auto absolute inset-0 z-0 rounded-sm focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" />
            {index + 1}
          </div>
          <div role="cell" className="pointer-events-none relative z-10 md:table-cell md:p-4 md:align-middle">
            <span className="flex items-center gap-3">
              <PoolLogo token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)} token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)} chainId={pool.chainId} />
              <span className="min-w-0"><span className="block text-sm font-medium">{pairLabel(pool, displayedToken)}</span><span className="text-xs text-muted-foreground">{pool.protocol.replace('uniswap_', '')} · {pool.fee / 10_000}%{pool.ponsDesignated && ' · Pons designated'}</span></span>
            </span>
          </div>
          {[
            ['FDV', formatPoolUsd(pool.fdvUsd)], ['24H volume', formatPoolUsd(pool.volume24hUsd)], ['Liquidity', formatPoolUsd(pool.tvlUsd)],
            ['1H', formatPercent(pool.change1h).text], ['1D', formatPercent(pool.change1d).text], ['Age', poolAge(pool.createdTimestamp)],
          ].map(([label, value], metricIndex) => <div key={label} role="cell" className="pointer-events-none relative z-10 md:table-cell md:p-4 md:text-right md:align-middle">
            <span className="mr-1 text-xs text-muted-foreground md:hidden">{label}</span><span className={metricIndex === 3 ? formatPercent(pool.change1h).className : metricIndex === 4 ? formatPercent(pool.change1d).className : undefined}>{value}</span>
          </div>)}
        </div>)}
      </div>
    </div> : <div className="grid gap-3 md:grid-cols-2">{items.map((pool) => <Card key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`}>
      <CardHeader className={cn('flex-row items-center gap-3', tokenAddress && 'w-52 shrink-0')}>
        <PoolLogo
          token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)}
          token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)}
          chainId={pool.chainId}
        />
        <div>
          <a className="text-sm font-semibold" href={poolHref(pool, tokenAddress ?? pool.displayedToken)}>{pairLabel(pool, displayedToken)}</a>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{`${pool.protocol.replace('uniswap_', '')} · ${pool.fee / 10_000}%`}</Badge>
            <span className="text-xs text-muted-foreground">{chainName(pool.chainId)}</span>
            {pool.ponsDesignated && <span className="text-xs">Pons designated pool</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        <p><span className="text-xs text-muted-foreground">24h volume</span><br /><span className="text-sm font-medium">{formatPoolUsd(pool.volume24hUsd)}</span></p>
        <p><span className="text-xs text-muted-foreground">Liquidity</span><br /><span className="text-sm font-medium">{formatPoolUsd(pool.tvlUsd)}</span></p>
        <p><span className="text-xs text-muted-foreground">Price</span><br /><span className="text-sm font-medium">{formatPoolUsd(pool.priceUsd)}</span></p>
        <p><span className="text-xs text-muted-foreground">FDV</span><br /><span className="text-sm font-medium">{formatPoolUsd(pool.fdvUsd)}</span></p>
        <p><span className="text-xs text-muted-foreground">1h</span><br /><span className={cn('text-sm font-medium', formatPercent(pool.change1h).className)}>{formatPercent(pool.change1h).text}</span></p>
        <p><span className="text-xs text-muted-foreground">1d</span><br /><span className={cn('text-sm font-medium', formatPercent(pool.change1d).className)}>{formatPercent(pool.change1d).text}</span></p>
        {pool.coverageStatus !== 'backfilling' && <p><span className="text-xs text-muted-foreground">Coverage</span><br /><span className="text-sm">{pool.coverageStatus.replace('_', ' ')}</span></p>}
        <p><span className="text-xs text-muted-foreground">Age</span><br /><span className="text-sm">{poolAge(pool.createdTimestamp)}</span></p>
        <p><span className="text-xs text-muted-foreground">Last trade</span><br /><span className="text-sm">{pool.lastTradeTimestamp === null ? '—' : new Date(pool.lastTradeTimestamp * 1000).toLocaleString('en-US')}</span></p>
      </CardContent></Card>)}</div>
    }
    {nextCursor && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
    {loadingMore && <p role="status" className="text-center text-sm text-muted-foreground">Loading more pools…</p>}
    {loadError && <div className="text-center text-sm"><span role="alert">Could not load more pools. </span><button type="button" onClick={() => void loadMore()}>Retry</button></div>}
  </section>;
}
