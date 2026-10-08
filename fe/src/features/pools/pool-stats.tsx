import type { Address } from 'viem';
import type { PoolSummary } from '@/api/client';
import { formatUsd } from '@/api/format';
import { PercentChange } from '@/components/percent-change';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatPoolUsd, isYoungerThan24h, poolAge } from './pool-format';
import { PoolBalances } from './pool-balances';

export interface PoolStatsProps {
  protocol: string;
  poolAddress: Address;
  fee: number;
  tvlUsd: string | null;
  fdvUsd: string | null;
  volume24hUsd: string | null;
  // Percent change vs the previous 24h window; null renders as "—" (unavailable, not 0%).
  volume24hChange?: string | null;
  // Percent change vs 24h ago; null renders "—" (unavailable, not 0%).
  tvlChange?: string | null;
  createdTimestamp: number | null;
  priceInQuote: string | null;
  poolBalances: PoolSummary['poolBalances'];
  displayed: { address: Address; symbol: string | null; decimals: number | null };
  other: { address: Address; symbol: string | null; decimals: number | null };
}

// 24h fees = volume x fee tier is an exact identity for a constant-fee-tier AMM pool (every swap
// pays exactly the pool's stated fee), not an estimate — derived here since the API doesn't store
// it separately. No Total APR: annualizing one day of fees over TVL is a real metric some
// dashboards show, but it was dropped from this page's scope rather than shipped as an estimate.
function feesUsd(volume24hUsd: string | null, fee: number): string | null {
  if (volume24hUsd === null) return null;
  const volume = Number(volume24hUsd);
  if (!Number.isFinite(volume)) return null;
  return String(volume * (fee / 1_000_000));
}

export function PoolStats({ protocol, poolAddress, fee, tvlUsd, fdvUsd, volume24hUsd, volume24hChange = null, tvlChange = null, createdTimestamp, priceInQuote, poolBalances, displayed, other }: PoolStatsProps) {
  return (
    <Card>
      <CardHeader><h2 className="text-2xl font-semibold">Stats</h2></CardHeader>
      <CardContent className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
        <div className="col-span-full">
          <h3 className="text-sm text-muted-foreground">Pool balances</h3>
          <div className="mt-1">
            <PoolBalances protocol={protocol} poolAddress={poolAddress} displayed={displayed} other={other}
              priceInQuote={priceInQuote} poolBalances={poolBalances} />
          </div>
        </div>
        <div><dt className="text-sm text-muted-foreground">TVL</dt><dd className="text-lg font-semibold">{formatPoolUsd(tvlUsd)}{tvlChange !== null && <span data-testid="tvl-change" className="ml-2 text-sm font-normal"><PercentChange value={tvlChange} /></span>}</dd></div>
        <div><dt className="text-sm text-muted-foreground">FDV</dt><dd className="text-lg font-semibold">{formatUsd(fdvUsd, 1)}</dd></div>
        <div><dt className="text-sm text-muted-foreground">24H volume</dt><dd className="text-lg font-semibold">{formatPoolUsd(volume24hUsd)}{volume24hChange !== null
            ? <span data-testid="volume-24h-change" className="ml-2 text-sm font-normal"><PercentChange value={volume24hChange} /></span>
            : volume24hUsd !== null && isYoungerThan24h(createdTimestamp)
              && <span data-testid="volume-24h-change" className="ml-2 text-sm font-normal text-muted-foreground">New</span>}</dd></div>
        <div><dt className="text-sm text-muted-foreground">24H fees</dt><dd className="text-lg font-semibold">{formatPoolUsd(feesUsd(volume24hUsd, fee))}</dd></div>
        <div><dt className="text-sm text-muted-foreground">Age</dt><dd className="text-lg font-semibold">{poolAge(createdTimestamp)}</dd></div>
      </CardContent>
    </Card>
  );
}
