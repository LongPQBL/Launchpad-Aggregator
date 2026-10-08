import Image from 'next/image';
import { TokenImage } from '@/features/launches/token-logo';

export interface PoolLogoToken {
  logoUri: string | null;
  symbol: string;
}

export interface PoolLogoProps {
  token0: PoolLogoToken;
  token1: PoolLogoToken;
  chainId?: number;
}

// token0 renders in front (caller passes whichever side is currently "displayed" first, so
// flipping the pair swaps which logo sits on top), token1 behind and offset right — two full
// circles stacked like a coin pile (Uniswap's pair-icon convention), not a split circle. The ring
// around token0 is page-background colored so its edge reads cleanly against token1 behind it.
export function PoolLogo({ token0, token1, chainId }: PoolLogoProps) {
  return (
    <span className="relative inline-flex h-12 w-[72px] shrink-0">
      <span className="absolute left-6 top-0 h-12 w-12 overflow-hidden rounded-full">
        <TokenImage logoUri={token1.logoUri} symbol={token1.symbol} className="h-12 w-12" />
      </span>
      <span className="absolute left-0 top-0 h-12 w-12 overflow-hidden rounded-full ring-2 ring-card">
        <TokenImage logoUri={token0.logoUri} symbol={token0.symbol} className="h-12 w-12" />
      </span>
      {chainId === 4663 && (
        <Image
          src="/images/chains/robinhood-chain.png"
          alt="Robinhood Chain"
          width={16}
          height={16}
          unoptimized
          className="absolute -bottom-0.5 -right-0.5 z-10 h-4 w-4 rounded-full border-2 border-card bg-card"
        />
      )}
    </span>
  );
}
