'use client';

import { useState } from 'react';
import type { Address } from 'viem';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SwapPanel, type SwapToken } from '@/trading/swap-panel';
import { V4SwapPanel } from '@/trading/v4-swap-panel';

export interface SwapTriggerProps {
  protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2';
  poolId: Address;
  tokenA: SwapToken;
  tokenB: SwapToken;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  explorerBase: string | null;
  targetChainName?: string;
}

export function SwapTrigger({ protocol, poolId, tokenA, tokenB, fee, tickSpacing, hooks, explorerBase, targetChainName = 'Robinhood Chain' }: SwapTriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="mx-px h-12 w-[calc(100%-2px)] cursor-pointer rounded-full bg-brand/20 text-base text-brand hover:bg-brand/25 hover:text-brand">Swap</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${tokenA.symbol ?? 'Token'} / ${tokenB.symbol ?? 'Token'}`} showHeader={false} contentClassName="max-w-[480px] rounded-2xl">
        {protocol === 'uniswap_v4' ? (
          <V4SwapPanel
            poolKey={{ currency0: tokenA.address, currency1: tokenB.address, fee, tickSpacing, hooks }}
            tokenA={tokenA}
            tokenB={tokenB}
            explorerBase={explorerBase}
            targetChainName={targetChainName}
          />
        ) : (
          <SwapPanel poolAddress={poolId} tokenA={tokenA} tokenB={tokenB} explorerBase={explorerBase} targetChainName={targetChainName} />
        )}
      </Dialog>
    </>
  );
}
