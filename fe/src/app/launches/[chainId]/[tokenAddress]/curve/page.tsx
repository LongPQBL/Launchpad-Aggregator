import { notFound } from 'next/navigation';
import { LiveRefreshIndicator } from '@/components/live-refresh-indicator';
import { CurveDetail } from '@/features/curve/curve-detail';
import { getCurveSummary, getLaunchCandles, getLaunchDetail, getLaunchHistory, getLaunchTransactions } from '@/api/client';
import { launchResourceKey } from '@/hooks/resource-keys';

interface CurveDetailPageProps {
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

export default async function CurveDetailPage({ params, searchParams }: CurveDetailPageProps) {
  const { chainId: chainIdParam, tokenAddress } = await params;
  const search = await searchParams;
  const intervalParam = Number(search.interval);
  const chartInterval = [60, 300, 900, 3600, 86400].includes(intervalParam) ? intervalParam : 3600;
  const chainId = parseChainId(chainIdParam);
  if (chainId === null || !isTokenAddress(tokenAddress)) notFound();

  let detail;
  let summary;
  try {
    [detail, summary] = await Promise.all([getLaunchDetail(chainId, tokenAddress), getCurveSummary(chainId, tokenAddress)]);
  } catch {
    return (
      <div role="alert">
        <p>Could not load the bonding curve from the server. Please try again.</p>
        <a href={`/launches/${chainId}/${tokenAddress}/curve`}>Retry</a>
      </div>
    );
  }
  // No launch, or a launch without a bonding-curve venue (not a Pons curve launch): nothing to show here.
  if (detail === null || summary === null) notFound();

  const [transactions, candles, history] = await Promise.all([
    getLaunchTransactions(chainId, tokenAddress, { venue: 'curve' }).catch(() => null),
    getLaunchCandles(chainId, tokenAddress, { currency: 'quote', intervalSeconds: chartInterval, venue: 'curve' }).catch(() => null),
    getLaunchHistory(chainId, tokenAddress, 86_400, 'curve').catch(() => null),
  ]);

  return (
    <>
      <LiveRefreshIndicator resourceKeys={[launchResourceKey(chainId, tokenAddress)]} />
      <CurveDetail detail={detail} summary={summary} transactions={transactions} candles={candles} history={history} chartInterval={chartInterval} />
    </>
  );
}
