import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { LaunchList } from '@/features/launches/launch-list';
import { getLaunches, getSources, type LaunchPage, type Source } from '@/api/client';
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

  let page: LaunchPage | null = null;
  let sources: readonly Source[] = [];
  let error = false;

  try {
    const [launchesResult, sourcesResult] = await Promise.all([getLaunches({ cursor, chainId }), getSources()]);
    page = launchesResult;
    sources = sourcesResult.items;
  } catch {
    error = true;
  }

  const resourceKeys = [...new Set(sources.map((source) => source.chainId))].map(chainResourceKey);

  return (
    <AppShell>
      {!error && <LiveRefreshIndicator resourceKeys={resourceKeys} />}
      <LaunchList page={page} sources={sources} error={error} chainId={chainId} />
    </AppShell>
  );
}
