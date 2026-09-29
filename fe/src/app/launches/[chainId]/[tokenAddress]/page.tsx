import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { LaunchDetail } from '@/features/launch/launch-detail';
import { getLaunchCandles, getLaunchDetail, getLaunchTrades } from '@/api/client';

interface LaunchDetailPageProps {
  params: Promise<{ chainId: string; tokenAddress: string }>;
}

function parseChainId(value: string): number | null {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isTokenAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export default async function LaunchDetailPage({ params }: LaunchDetailPageProps) {
  const { chainId: chainIdParam, tokenAddress } = await params;
  const chainId = parseChainId(chainIdParam);
  if (chainId === null || !isTokenAddress(tokenAddress)) notFound();

  let detail;
  try {
    detail = await getLaunchDetail(chainId, tokenAddress);
  } catch {
    return (
      <AppShell>
        <div role="alert">
          <p>Không tải được thông tin launch từ máy chủ. Vui lòng thử lại.</p>
          <a href={`/launches/${chainId}/${tokenAddress}`}>Thử lại</a>
        </div>
      </AppShell>
    );
  }
  if (detail === null) notFound();

  const [trades, candles] = await Promise.all([
    getLaunchTrades(chainId, tokenAddress).catch(() => null),
    getLaunchCandles(chainId, tokenAddress).catch(() => null),
  ]);

  return (
    <AppShell>
      <LaunchDetail detail={detail} trades={trades} candles={candles} />
    </AppShell>
  );
}
