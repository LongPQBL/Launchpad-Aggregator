import type { Address } from 'viem';
import type { PoolSummary } from '@/api/client';
import { PercentChange, RollingText } from '@/components/percent-change';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatPoolUsd, isYoungerThan24h, poolAge } from './pool-format';
import { PoolBalances } from './pool-balances';

export interface PoolStatsProps {
  protocol: string;
  poolAddress: Address;
  fee: number;
  /** The pool's hook address; a pool with a hook may charge fees the pool's own fee tier does not show. */
  hooks?: string | null;
  tvlUsd: string | null;
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
// it separately. A pool with a hook can take its own fee on top of (or instead of) the tier, so its fees are unknown, not volume x tier.
// No Total APR: annualizing one day of fees over TVL is a real metric some
// dashboards show, but it was dropped from this page's scope rather than shipped as an estimate.
const NO_HOOK = '0x0000000000000000000000000000000000000000';
function feesUsd(volume24hUsd: string | null, fee: number, hooks: string | null | undefined): string | null {
  if (volume24hUsd === null) return null;
  if (hooks && hooks.toLowerCase() !== NO_HOOK) return null;
  const volume = Number(volume24hUsd);
  if (!Number.isFinite(volume)) return null;
  return String(volume * (fee / 1_000_000));
}

export function PoolStats({ protocol, poolAddress, fee, hooks = null, tvlUsd, volume24hUsd, volume24hChange = null, tvlChange = null, createdTimestamp, priceInQuote, poolBalances, displayed, other }: PoolStatsProps) {
  return (
    <Card className="rounded-[20px] border-0 bg-muted">
      <CardHeader className="p-5 pb-0"><h2 className="text-2xl">Stats</h2></CardHeader>
      <CardContent className="mt-6 grid gap-x-4 gap-y-5 p-5 pt-0 sm:grid-cols-2">
        <div className="col-span-full">
          <h3 className="text-sm text-muted-foreground">Pool balances</h3>
          <div className="mt-1">
            <PoolBalances protocol={protocol} poolAddress={poolAddress} displayed={displayed} other={other}
              priceInQuote={priceInQuote} poolBalances={poolBalances} />
          </div>
        </div>
        <div><dt className="text-sm text-muted-foreground">TVL</dt><dd className="flex flex-wrap items-baseline gap-x-2 text-lg"><RollingText text={formatPoolUsd(tvlUsd)} value={tvlUsd} flash />{tvlChange !== null && <span data-testid="tvl-change" className="text-sm"><PercentChange value={tvlChange} /></span>}</dd></div>
        <div><dt className="text-sm text-muted-foreground">24H volume</dt><dd className="flex flex-wrap items-baseline gap-x-2 text-lg"><RollingText text={formatPoolUsd(volume24hUsd)} value={volume24hUsd} flash />{volume24hChange !== null
            ? <span data-testid="volume-24h-change" className="text-sm"><PercentChange value={volume24hChange} /></span>
            : volume24hUsd !== null && isYoungerThan24h(createdTimestamp)
              && <span data-testid="volume-24h-change" className="text-sm text-muted-foreground">New</span>}</dd></div>
        <div><dt className="text-sm text-muted-foreground">24H fees</dt><dd className="text-lg"><RollingText text={formatPoolUsd(feesUsd(volume24hUsd, fee, hooks))} value={feesUsd(volume24hUsd, fee, hooks)} flash /></dd></div>
        <div><dt className="text-sm text-muted-foreground">Age</dt><dd className="text-lg"><RollingText text={poolAge(createdTimestamp)} /></dd></div>
      </CardContent>
    </Card>
  );
}
