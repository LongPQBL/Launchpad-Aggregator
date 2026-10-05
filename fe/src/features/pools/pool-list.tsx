import { chainName } from '@/api/chains';
import { poolHref, type PoolPage, type PoolSummary } from '@/api/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

function metric(value: string | null, prefix = ''): string { return value === null ? '—' : `${prefix}${value}`; }
function short(address: string): string { return address === '0x0000000000000000000000000000000000000000' ? 'ETH' : `${address.slice(0, 6)}…${address.slice(-4)}`; }
function pair(pool: PoolSummary): string { return `${short(pool.currency0)} / ${short(pool.currency1)}`; }
export function poolAge(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function PoolList({ page, error = false, tokenAddress, chainId }: {
  page: PoolPage | null; error?: boolean; tokenAddress?: string; chainId?: number;
}) {
  if (error || !page) return <p role="alert">Could not load pools. Please try again.</p>;
  return <section aria-label={tokenAddress ? 'Other pools for this token' : 'Pools'} className="space-y-4">
    {!tokenAddress && <div><h1 className="text-2xl font-semibold">Pools</h1>
      <p className="text-sm text-muted-foreground">Verified indexed Uniswap pools on Robinhood Chain. Supported sources: {page.supportedProtocols.map((p) => p.replace('uniswap_', 'V')).join(', ')}. Coverage may still be backfilling.</p></div>}
    {page.items.length === 0 && <p>No verified indexed pools found.</p>}
    <div className="grid gap-3 md:grid-cols-2">{page.items.map((pool) => <Card key={`${pool.chainId}:${pool.protocol}:${pool.poolId}`}>
      <CardHeader><a className="font-semibold hover:underline" href={poolHref(pool, tokenAddress ?? pool.displayedToken)}>{pair(pool)}</a>
        <p className="text-xs text-muted-foreground">{chainName(pool.chainId)} · Uniswap {pool.protocol.replace('uniswap_', 'V')} · Fee {pool.fee / 10_000}%</p>
        {pool.ponsDesignated && <span className="text-xs">Pons designated pool</span>}</CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 text-sm">
        <p>24h volume: {metric(pool.volume24hUsd, '$')}</p><p>Liquidity: {metric(pool.tvlUsd, '$')}</p>
        <p>Price: {metric(pool.priceUsd, '$')}</p><p>FDV (pool price): {metric(pool.fdvUsd, '$')}</p>
        <p>1h: {metric(pool.change1h, '')}</p><p>1d: {metric(pool.change1d, '')}</p>
        <p>Coverage: {pool.coverageStatus.replace('_', ' ')}</p>
        <p>Age: {poolAge(pool.createdTimestamp)}</p>
        <p>Last trade: {pool.lastTradeTimestamp === null ? '—' : new Date(pool.lastTradeTimestamp * 1000).toLocaleString('en-US')}</p>
      </CardContent></Card>)}</div>
    {page.nextCursor && !tokenAddress && <a className="underline" href={`/pools?cursor=${encodeURIComponent(page.nextCursor)}${chainId ? `&chainId=${chainId}` : ''}`}>Next page</a>}
  </section>;
}
