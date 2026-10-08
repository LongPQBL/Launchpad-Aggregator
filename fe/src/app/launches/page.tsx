import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { LaunchList } from '@/features/launches/launch-list';
import { ApiError, getLaunches, getSources, type LaunchPage, type Source, type LaunchQuery } from '@/api/client';
import { chainResourceKey } from '@/hooks/resource-keys';

interface LaunchesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function values(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
}

function parseChainIds(value: string | string[] | undefined): number[] {
  return [...new Set(values(value).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export default async function LaunchesPage({ searchParams }: LaunchesPageProps) {
  const params = await searchParams;
  const cursor = first(params.cursor);
  const chainIds = parseChainIds(params.chainId);
  const search = first(params.search) || undefined;
  const status = first(params.status) || undefined;
  const platforms = [...new Set(values(params.platform))];
  const tab = first(params.tab) || undefined;

  let page: LaunchPage | null = null;
  let sources: readonly Source[] = [];
  let error = false;
  let rankingUnavailable = false;

  const defaultSort = tab === 'recent' ? 'recent' : 'volume24hUsd';
  const requestedSort = first(params.sort);
  const allowedSorts = ['recent', 'volume24hUsd', 'fdvUsd', 'tvlUsd', 'change1h', 'change1d'];
  const sort = (allowedSorts.includes(requestedSort ?? '') ? requestedSort : defaultSort) as NonNullable<LaunchQuery['sort']>;
  const requestedDirection = first(params.direction);
  const direction = requestedDirection === 'asc' || requestedDirection === 'desc' ? requestedDirection : undefined;

  try {
    const [launchesResult, sourcesResult] = await Promise.all([getLaunches({ cursor, chainId: chainIds.length ? chainIds : undefined, search, status, platform: platforms.length ? platforms : undefined, sort, direction }), getSources()]);
    page = launchesResult;
    sources = sourcesResult.items;
  } catch (caught) {
    error = true;
    rankingUnavailable = caught instanceof ApiError && caught.status === 503;
  }

  const resourceKeys = [...new Set(sources.map((source) => source.chainId))].map(chainResourceKey);

  return (
    <AppShell>
      {!error && <LiveRefreshIndicator resourceKeys={resourceKeys} />}
      <LaunchList page={page} sources={sources} error={error} rankingUnavailable={rankingUnavailable} chainId={chainIds} search={search} status={status} platform={platforms} tab={tab} sort={sort} direction={direction} />
    </AppShell>
  );
}
