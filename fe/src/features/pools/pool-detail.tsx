import { launchHref, poolHref, type PoolCandlePage, type PoolSummary, type PoolTradePage } from '@/api/client';
import { chainName } from '@/api/chains';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import Link from 'next/link';
import { PoolChart } from './pool-chart';
import { poolAge } from './pool-list';

const zero = '0x0000000000000000000000000000000000000000';
function symbol(address: string): string { return address === zero ? 'ETH' : `${address.slice(0, 6)}…${address.slice(-4)}`; }
function metric(value: string | null, prefix = '', suffix = ''): string { return value === null ? '—' : `${prefix}${value}${suffix}`; }
export function PoolDetail({ pool, trades, candles }: { pool: PoolSummary; trades: PoolTradePage | null; candles: PoolCandlePage | null }) {
  const other = pool.displayedToken === pool.currency0 ? pool.currency1 : pool.currency0;
  const quote = symbol(other);
  return <article className="space-y-4">
    <Link href="/pools" className="text-sm underline">← Pools</Link>
    <Card><CardHeader><h1 className="text-2xl font-semibold">{symbol(pool.currency0)} / {symbol(pool.currency1)}</h1>
      <p>{chainName(pool.chainId)} · Uniswap {pool.protocol.replace('uniswap_', 'V')} {pool.ponsDesignated && '· Pons designated pool'}</p></CardHeader>
      <CardContent className="space-y-4"><div className="flex flex-wrap gap-2">
        <a className="rounded border px-3 py-1" aria-current={pool.displayedToken === pool.currency0 ? 'page' : undefined}
          href={poolHref(pool, pool.currency0)}>View {symbol(pool.currency0)}</a>
        <a className="rounded border px-3 py-1" aria-current={pool.displayedToken === pool.currency1 ? 'page' : undefined}
          href={poolHref(pool, pool.currency1)}>View {symbol(pool.currency1)}</a></div>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div><dt>Price in {quote}</dt><dd>{metric(pool.priceInQuote, '', ` ${quote}`)}</dd></div>
        <div><dt>Price USD</dt><dd>{metric(pool.priceUsd, '$')}</dd></div>
        <div><dt>24h volume USD</dt><dd>{metric(pool.volume24hUsd, '$')}</dd></div>
        <div><dt>Liquidity USD</dt><dd>{metric(pool.tvlUsd, '$')}</dd></div>
        <div><dt>FDV (pool price)</dt><dd>{metric(pool.fdvUsd, '$')}</dd></div>
        <div><dt>1h change</dt><dd>{metric(pool.change1h, '', '%')}</dd></div>
        <div><dt>1d change</dt><dd>{metric(pool.change1d, '', '%')}</dd></div>
        <div><dt>Coverage</dt><dd>{pool.coverageStatus.replace('_', ' ')}</dd></div>
        <div><dt>Fee</dt><dd>{pool.fee / 10_000}%</dd></div>
        {pool.protocol !== 'uniswap_v2' && <div><dt>Tick spacing</dt><dd>{pool.tickSpacing}</dd></div>}
        {pool.protocol === 'uniswap_v4' && <div><dt>Hook</dt><dd className="break-all font-mono">{pool.hooks}</dd></div>}
        <div><dt>Created block</dt><dd>{pool.createdBlock}</dd></div>
        <div><dt>Age</dt><dd>{poolAge(pool.createdTimestamp)}</dd></div>
        <div><dt>Last trade</dt><dd>{pool.lastTradeTimestamp === null ? '—' : new Date(pool.lastTradeTimestamp * 1000).toLocaleString('en-US')}</dd></div>
      </dl>{pool.launchTokenAddress && <a className="underline" href={launchHref(pool.chainId, pool.launchTokenAddress)}>View Pons launch</a>}
      </CardContent></Card>
    {candles && <PoolChart candles={candles} coverageStatus={pool.coverageStatus} quoteSymbol={quote} />}
    <Card><CardHeader><h2 className="font-semibold">Pool trades</h2></CardHeader><CardContent>
      {trades ? <><div className="space-y-2 text-sm">{trades.items.map((trade) => <p key={`${trade.txHash}:${trade.logIndex}`}>
        {new Date(trade.timestamp * 1000).toLocaleString('en-US')} · {trade.side} · {metric(trade.usdValue, '$')} · {trade.usdValueStatus}
      </p>)}</div>{trades.nextCursor && <a className="mt-3 block underline" href={`${poolHref(pool, pool.displayedToken)}&cursor=${encodeURIComponent(trades.nextCursor)}`}>Next trades</a>}</>
        : <p role="status">Could not load pool trades.</p>}</CardContent></Card>
  </article>;
}
