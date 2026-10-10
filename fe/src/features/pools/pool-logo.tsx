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
  /** 'small' is for list rows; 'detail' is the responsive page header size. */
  size?: 'default' | 'small' | 'detail';
}

// token0 renders in front (caller passes whichever side is currently "displayed" first, so
// flipping the pair swaps which logo sits on top), token1 behind and offset right — two full
// circles stacked like a coin pile (Uniswap's pair-icon convention), not a split circle. There is no
// outline ring (in the dark theme it read as a black border); each circle sits on an opaque background so a
// translucent placeholder letter does not show the other logo through it.
export function PoolLogo({ token0, token1, chainId, size = 'default' }: PoolLogoProps) {
  const small = size === 'small';
  const detail = size === 'detail';
  const circle = small ? 'h-8 w-8' : detail ? 'h-14 w-14 group-data-[compact=true]:h-10 group-data-[compact=true]:w-10' : 'h-12 w-12';
  const logoStack = small ? 'h-8 w-12' : detail ? 'h-14 w-[82px] group-data-[compact=true]:h-10 group-data-[compact=true]:w-[60px]' : 'h-12 w-[72px]';
  const secondLogoOffset = small ? 'left-4' : detail ? 'left-7 group-data-[compact=true]:left-5' : 'left-6';
  const badge = small ? 'h-4 w-4' : detail ? 'h-[23px] w-[23px] group-data-[compact=true]:h-[17px] group-data-[compact=true]:w-[17px]' : 'h-4 w-4';
  return (
    <span className={`relative inline-flex shrink-0 ${logoStack}`}>
      <span className={`absolute ${secondLogoOffset} top-0 ${circle} overflow-hidden rounded-full bg-card`}>
        <TokenImage logoUri={token1.logoUri} symbol={token1.symbol} className={circle} />
      </span>
      <span className={`absolute left-0 top-0 ${circle} overflow-hidden rounded-full bg-card`}>
        <TokenImage logoUri={token0.logoUri} symbol={token0.symbol} className={circle} />
      </span>
      {chainId === 4663 && (
        <Image
          src="/images/chains/robinhood-chain.png"
          alt="Robinhood Chain"
          width={16}
          height={16}
          unoptimized
          className={`absolute -bottom-0.5 -right-0.5 z-10 ${badge} rounded-full border-2 border-card bg-card`}
        />
      )}
    </span>
  );
}
