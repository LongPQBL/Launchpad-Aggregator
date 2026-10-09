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
  /** 'small' is for list rows (40px circles); the default 48px is for page headers. */
  size?: 'default' | 'small';
}

// token0 renders in front (caller passes whichever side is currently "displayed" first, so
// flipping the pair swaps which logo sits on top), token1 behind and offset right — two full
// circles stacked like a coin pile (Uniswap's pair-icon convention), not a split circle. The ring
// around token0 is page-background colored so its edge reads cleanly against token1 behind it.
export function PoolLogo({ token0, token1, chainId, size = 'default' }: PoolLogoProps) {
  const small = size === 'small';
  const circle = small ? 'h-10 w-10' : 'h-12 w-12';
  return (
    <span className={`relative inline-flex shrink-0 ${small ? 'h-10 w-[60px]' : 'h-12 w-[72px]'}`}>
      <span className={`absolute ${small ? 'left-5' : 'left-6'} top-0 ${circle} overflow-hidden rounded-full`}>
        <TokenImage logoUri={token1.logoUri} symbol={token1.symbol} className={circle} />
      </span>
      <span className={`absolute left-0 top-0 ${circle} overflow-hidden rounded-full ring-2 ring-card`}>
        <TokenImage logoUri={token0.logoUri} symbol={token0.symbol} className={circle} />
      </span>
      {chainId === 4663 && (
        <Image
          src="/images/chains/robinhood-chain.png"
          alt="Robinhood Chain"
          width={16}
          height={16}
          unoptimized
          className={`absolute -bottom-0.5 -right-0.5 z-10 ${small ? 'h-3.5 w-3.5' : 'h-4 w-4'} rounded-full border-2 border-card bg-card`}
        />
      )}
    </span>
  );
}
