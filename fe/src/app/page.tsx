import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { LaunchList } from '@/features/launches/launch-list';
import { ApiError, getLaunches, getSources, type LaunchPage, type Source } from '@/api/client';
import { chainResourceKey } from '@/hooks/resource-keys';

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseChainId(value: string | string[] | undefined): number | undefined {
  const raw = first(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const cursor = first(params.cursor);
  const chainId = parseChainId(params.chainId);
  const search = first(params.search) || undefined;
  const status = first(params.status) || undefined;
  const platform = first(params.platform) || undefined;
  const tab = first(params.tab) || undefined;

  let page: LaunchPage | null = null;
  let sources: readonly Source[] = [];
  let error = false;
  let rankingUnavailable = false;

  const sort = tab === 'recent' ? 'recent' : 'volume24hUsd';

  try {
    const [launchesResult, sourcesResult] = await Promise.all([getLaunches({ cursor, chainId, search, status, platform, sort }), getSources()]);
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
      <LaunchList page={page} sources={sources} error={error} rankingUnavailable={rankingUnavailable} chainId={chainId} search={search} status={status} platform={platform} tab={tab} />
    </AppShell>
  );
}
