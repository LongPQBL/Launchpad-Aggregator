import { getPools, type PoolPage } from '@/api/client';
import { PoolList } from '@/features/pools/pool-list';

interface Props { searchParams: Promise<Record<string, string | string[] | undefined>> }
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
export default async function PoolsPage({ searchParams }: Props) {
  const params = await searchParams;
  const cursor = first(params.cursor);
  const chainRaw = first(params.chainId);
  const chainId = chainRaw && /^\d+$/.test(chainRaw) ? Number(chainRaw) : undefined;
  let page: PoolPage | null = null;
  try { page = await getPools({ cursor, chainId }); } catch { /* show retry state */ }
  return <><PoolList page={page} error={!page} /></>;
}
