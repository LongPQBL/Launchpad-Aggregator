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
}

export function SwapTrigger({ protocol, poolId, tokenA, tokenB, fee, tickSpacing, hooks, explorerBase }: SwapTriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="w-1/2 cursor-pointer rounded-full bg-[#d4ff2b]/15 text-[#d4ff2b] hover:bg-[#d4ff2b]/25">Swap</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Swap">
        {protocol === 'uniswap_v4' ? (
          <V4SwapPanel
            poolKey={{ currency0: tokenA.address, currency1: tokenB.address, fee, tickSpacing, hooks }}
            tokenA={tokenA}
            tokenB={tokenB}
            explorerBase={explorerBase}
          />
        ) : (
          <SwapPanel poolAddress={poolId} tokenA={tokenA} tokenB={tokenB} explorerBase={explorerBase} />
        )}
      </Dialog>
    </>
  );
}
