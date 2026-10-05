import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { getPoolCandles, getPoolDetail, getPoolTrades } from '@/api/client';
import { PoolDetail } from '@/features/pools/pool-detail';

interface Props {
  params: Promise<{ chainId: string; protocol: string; poolId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
export default async function PoolDetailPage({ params, searchParams }: Props) {
  const { chainId: raw, protocol, poolId } = await params;
  const query = await searchParams;
  const chainId = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(chainId) || chainId < 1
    || !['uniswap_v4', 'uniswap_v3', 'uniswap_v2'].includes(protocol)
    || (protocol === 'uniswap_v4' ? !/^0x[0-9a-fA-F]{64}$/.test(poolId) : !/^0x[0-9a-fA-F]{40}$/.test(poolId))) notFound();
  let detail;
  try { detail = await getPoolDetail(chainId, protocol, poolId, first(query.displayedToken)); }
  catch { return <AppShell><p role="alert">Could not load this pool. Please try again.</p></AppShell>; }
  if (!detail) notFound();
  const [trades, candles] = await Promise.all([
    getPoolTrades(detail, first(query.cursor)).catch(() => null),
    getPoolCandles(detail).catch(() => null),
  ]);
  return <AppShell><PoolDetail pool={detail} trades={trades} candles={candles} /></AppShell>;
}
