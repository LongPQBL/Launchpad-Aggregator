import { getPools, type PoolPage } from '@/api/client';
import { PoolList } from '@/features/pools/pool-list';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { chainResourceKey } from '@/hooks/resource-keys';
import { ROADMAP_CHAIN_IDS } from '@/api/chains';

interface Props { searchParams: Promise<Record<string, string | string[] | undefined>> }
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
export default async function PoolsPage({ searchParams }: Props) {
  const params = await searchParams;
  const cursor = first(params.cursor);
  const chainRaw = first(params.chainId);
  const chainId = chainRaw && /^\d+$/.test(chainRaw) ? Number(chainRaw) : undefined;
  let page: PoolPage | null = null;
  try { page = await getPools({ cursor, chainId }); } catch { /* show retry state */ }
  const resourceKeys = [...new Set([...(page?.items.map((pool) => pool.chainId) ?? []), ...(chainId === undefined ? ROADMAP_CHAIN_IDS : [chainId])])].map(chainResourceKey);
  return <>{page && <LiveRefreshIndicator resourceKeys={resourceKeys} />}<PoolList page={page} error={!page} /></>;
}
