import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { LaunchDetail } from '@/features/launch/launch-detail';
import { getLaunchCandles, getLaunchDetail, getLaunchPools, getLaunchTransactions } from '@/api/client';
import { launchResourceKey } from '@/hooks/resource-keys';

interface LaunchDetailPageProps {
  params: Promise<{ chainId: string; tokenAddress: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parseChainId(value: string): number | null {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isTokenAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export default async function LaunchDetailPage({ params, searchParams }: LaunchDetailPageProps) {
  const { chainId: chainIdParam, tokenAddress } = await params;
  const search = await searchParams;
  const chartCurrency: 'quote' | 'usd' = search.currency === 'usd' ? 'usd' : 'quote';
  const intervalParam = Number(search.interval);
  const chartInterval = [60, 300, 900, 3600, 86400].includes(intervalParam) ? intervalParam : 3600;
  const transactionsCursor = typeof search.cursor === 'string' ? search.cursor : undefined;
  const chainId = parseChainId(chainIdParam);
  if (chainId === null || !isTokenAddress(tokenAddress)) notFound();

  let detail;
  try {
    detail = await getLaunchDetail(chainId, tokenAddress);
  } catch {
    return (
      <AppShell>
        <div role="alert">
          <p>Could not load launch details from the server. Please try again.</p>
          <a href={`/launches/${chainId}/${tokenAddress}`}>Retry</a>
        </div>
      </AppShell>
    );
  }
  if (detail === null) notFound();

  const [transactions, candles, pools] = await Promise.all([
    getLaunchTransactions(chainId, tokenAddress, { cursor: transactionsCursor }).catch(() => null),
    getLaunchCandles(chainId, tokenAddress, { currency: chartCurrency, intervalSeconds: chartInterval }).catch(() => null),
    getLaunchPools(chainId, tokenAddress, { excludeOfficial: true }).catch(() => null),
  ]);
  const hasPendingTrade = transactions?.items.some((trade) => trade.usdValueStatus === 'pending') ?? false;

  return (
    <AppShell>
      {/* Launch-only (not chainResourceKey): matchesResourceKeys() already lets a launch key
          through for chain-wide events with no tokenAddress, so this page won't refetch on
          every other token's trade — see the Task 4 review-fix ruling in the plan ledger. */}
      <LiveRefreshIndicator resourceKeys={[launchResourceKey(chainId, tokenAddress)]} retryWhilePending={hasPendingTrade} />
      <LaunchDetail detail={detail} transactions={transactions} candles={candles} pools={pools} chartCurrency={chartCurrency} chartInterval={chartInterval} />
    </AppShell>
  );
}
