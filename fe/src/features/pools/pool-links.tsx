import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { launchHref, poolHref, type PoolSummary } from '@/api/client';
import { chainExplorerBase, chainIcon } from '@/api/chains';
import { CopyableTokenAddress } from '@/features/launch/copyable-token-address';
import { TokenImage } from '@/features/launches/token-logo';
import { short as shortSymbol } from './pool-format';

function PairLogo({ pool, token0, token1 }: {
  pool: PoolSummary;
  token0: { symbol: string; logoUri: string | null };
  token1: { symbol: string; logoUri: string | null };
}) {
  const icon = chainIcon(pool.chainId);

  return (
    <span className="relative inline-flex h-8 w-8 shrink-0">
      <span className="absolute inset-0 flex overflow-hidden rounded-full">
        <span className="h-8 w-4 shrink-0 overflow-hidden">
          <TokenImage logoUri={token0.logoUri} symbol={token0.symbol} className="h-8 w-8 max-w-none" />
        </span>
        <span className="h-8 w-4 shrink-0 overflow-hidden">
          <TokenImage logoUri={token1.logoUri} symbol={token1.symbol} className="h-8 w-8 max-w-none -translate-x-4" />
        </span>
      </span>
      {icon && <Image src={icon} alt="" aria-hidden="true" width={16} height={16} unoptimized
        className="absolute -bottom-0.5 -right-0.5 z-10 h-4 w-4 rounded-full border-2 border-card bg-card" />}
    </span>
  );
}

function ExplorerLink({ href, label }: { href: string | undefined; label: string }) {
  const icon = (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path d="M9 2.5h4.5V7M13.25 2.75 7 9M12 8.5v4A1.5 1.5 0 0 1 10.5 14h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" aria-label={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      {icon}
    </a>
  ) : (
    <span aria-label={`${label} unavailable`} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/50">
      {icon}
    </span>
  );
}

function LinkRow({ logo, name, nameHref, address, addressLabel, explorerHref, explorerLabel }: {
  logo: ReactNode;
  name: string;
  nameHref?: string;
  address: string;
  addressLabel: string;
  explorerHref?: string;
  explorerLabel: string;
}) {
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2">
      {logo}
      <div className="min-w-0 truncate text-sm">
        {nameHref ? <Link href={nameHref} className="hover:underline">{name}</Link> : <span>{name}</span>}
      </div>
      <CopyableTokenAddress address={address} label={addressLabel} showCopyIcon />
      <ExplorerLink href={explorerHref} label={explorerLabel} />
    </div>
  );
}

export function PoolLinks({ pool }: { pool: PoolSummary }) {
  const displayedIsCurrency0 = pool.displayedToken.toLowerCase() === pool.currency0.toLowerCase();
  const displayed = displayedIsCurrency0
    ? { address: pool.currency0, symbol: pool.currency0Symbol ?? shortSymbol(pool.currency0), logoUri: pool.currency0LogoUri }
    : { address: pool.currency1, symbol: pool.currency1Symbol ?? shortSymbol(pool.currency1), logoUri: pool.currency1LogoUri };
  const other = displayedIsCurrency0
    ? { address: pool.currency1, symbol: pool.currency1Symbol ?? shortSymbol(pool.currency1), logoUri: pool.currency1LogoUri }
    : { address: pool.currency0, symbol: pool.currency0Symbol ?? shortSymbol(pool.currency0), logoUri: pool.currency0LogoUri };
  const explorerBase = chainExplorerBase(pool.chainId);
  const poolName = `${displayed.symbol} / ${other.symbol}`;
  const launchTokenAddress = pool.launchTokenAddress?.toLowerCase();
  const tokenHref = (address: string) => launchTokenAddress === address.toLowerCase()
    ? launchHref(pool.chainId, address)
    : undefined;

  return (
    <section aria-labelledby="pool-links-heading" className="space-y-3 px-5">
      <h2 id="pool-links-heading" className="text-2xl">Links</h2>
      <div className="space-y-3">
        <LinkRow
          logo={<PairLogo pool={pool} token0={displayed} token1={other} />}
          name={poolName}
          nameHref={poolHref(pool, pool.displayedToken)}
          address={pool.poolId}
          addressLabel="Pool address"
          explorerHref={explorerBase ? `${explorerBase}/address/${pool.poolId}` : undefined}
          explorerLabel="Open pool in explorer"
        />
        {[displayed, other].map((token) => (
          <LinkRow
            key={token.address}
            logo={(
              <span className="relative inline-flex h-8 w-8 shrink-0">
                <TokenImage logoUri={token.logoUri} symbol={token.symbol} className="h-8 w-8 rounded-full" />
                {chainIcon(pool.chainId) && <Image src={chainIcon(pool.chainId)!} alt="" aria-hidden="true" width={16} height={16} unoptimized
                  className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card bg-card" />}
              </span>
            )}
            name={token.symbol}
            nameHref={tokenHref(token.address)}
            address={token.address}
            addressLabel={`${token.symbol} address`}
            explorerHref={explorerBase ? `${explorerBase}/token/${token.address}` : undefined}
            explorerLabel={`Open ${token.symbol} in explorer`}
          />
        ))}
      </div>
    </section>
  );
}
