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

// Each half renders the full 8x8 image/placeholder, then a clip-path cuts away the other side —
// not two overlapping circles — so the two halves tile into one clean split circle (matches
// Uniswap's pool-icon convention). Chain badge overlay matches TokenLogo's own placement/sizing.
export function PoolLogo({ token0, token1, chainId }: PoolLogoProps) {
  return (
    <span className="relative inline-flex h-8 w-8 shrink-0 overflow-hidden rounded-full">
      <span className="absolute inset-0 overflow-hidden" style={{ clipPath: 'inset(0 50% 0 0)' }}>
        <TokenImage logoUri={token0.logoUri} symbol={token0.symbol} className="h-8 w-8" />
      </span>
      <span className="absolute inset-0 overflow-hidden" style={{ clipPath: 'inset(0 0 0 50%)' }}>
        <TokenImage logoUri={token1.logoUri} symbol={token1.symbol} className="h-8 w-8" />
      </span>
      {chainId === 4663 && (
        <Image
          src="/images/chains/robinhood-chain.png"
          alt="Robinhood Chain"
          width={16}
          height={16}
          unoptimized
          className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card bg-card"
        />
      )}
    </span>
  );
}
