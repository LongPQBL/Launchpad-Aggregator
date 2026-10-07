import { chainName } from '@/api/chains';
import { formatPercent, formatUsd } from '@/api/format';
import { poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PoolLogo, type PoolLogoToken } from './pool-logo';
import { cn } from '@/lib/utils';

export function short(address: string): string { return address === '0x0000000000000000000000000000000000000000' ? 'ETH' : `${address.slice(0, 6)}…${address.slice(-4)}`; }
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
export function poolAge(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function PoolList({ page, error = false, tokenAddress, chainId, displayedToken }: {
  page: PoolPage | null; error?: boolean; tokenAddress?: string; chainId?: number;
  displayedToken?: PoolListDisplayedToken;
}) {
  if (error || !page) return <p role="alert">Could not load pools. Please try again.</p>;
  return <section aria-label={tokenAddress ? 'Other pools for this token' : 'Pools'} className="space-y-4">
    {!tokenAddress && <div><h1 className="text-2xl font-semibold">Pools</h1>
      <p className="text-sm text-muted-foreground">Verified indexed Uniswap pools on Robinhood Chain. Supported sources: {page.supportedProtocols.map((p) => p.replace('uniswap_', '')).join(', ')}. Coverage may still be backfilling.</p></div>}
    {page.items.length === 0 && <p>No verified indexed pools found.</p>}
    <div className="grid gap-3 md:grid-cols-2">{page.items.map((pool) => <Card key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`}>
      <CardHeader className="flex-row items-center gap-3">
        <PoolLogo
          token0={poolLogoToken(pool, pool.currency0, pool.currency0Symbol, pool.currency0LogoUri, displayedToken)}
          token1={poolLogoToken(pool, pool.currency1, pool.currency1Symbol, pool.currency1LogoUri, displayedToken)}
          chainId={pool.chainId}
        />
        <div>
          <a className="font-semibold hover:underline" href={poolHref(pool, tokenAddress ?? pool.displayedToken)}>{pairLabel(pool, displayedToken)}</a>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{`${pool.protocol.replace('uniswap_', '')} · ${pool.fee / 10_000}%`}</Badge>
            <span className="text-xs text-muted-foreground">{chainName(pool.chainId)}</span>
            {pool.ponsDesignated && <span className="text-xs">Pons designated pool</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 text-sm">
        <p>24h volume: {formatUsd(pool.volume24hUsd, 1)}</p><p>Liquidity: {formatUsd(pool.tvlUsd, 1)}</p>
        <p>Price: {formatUsd(pool.priceUsd, 1)}</p><p>FDV (pool price): {formatUsd(pool.fdvUsd, 1)}</p>
        <p>1h: <span className={cn(formatPercent(pool.change1h).className)}>{formatPercent(pool.change1h).text}</span></p>
        <p>1d: <span className={cn(formatPercent(pool.change1d).className)}>{formatPercent(pool.change1d).text}</span></p>
        <p>Coverage: {pool.coverageStatus.replace('_', ' ')}</p>
        <p>Age: {poolAge(pool.createdTimestamp)}</p>
        <p>Last trade: {pool.lastTradeTimestamp === null ? '—' : new Date(pool.lastTradeTimestamp * 1000).toLocaleString('en-US')}</p>
      </CardContent></Card>)}</div>
    {page.nextCursor && !tokenAddress && <a className="underline" href={`/pools?cursor=${encodeURIComponent(page.nextCursor)}${chainId ? `&chainId=${chainId}` : ''}`}>Next page</a>}
  </section>;
}
