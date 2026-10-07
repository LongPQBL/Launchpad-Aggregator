'use client';

import type { Address } from 'viem';
import { Tabs } from '@/components/ui/tabs';
import { BuyPanel } from './buy-panel';
import { SellPanel } from './sell-panel';

export interface CurveTradePanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  tokenDecimals: number;
  tokenSymbol?: string | null;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

export function CurveTradePanel({ curveAddress, tokenAddress, tokenDecimals, tokenSymbol, quoteAsset, explorerBase }: CurveTradePanelProps) {
  return (
    <Tabs
      tabs={[
        { value: 'buy', label: 'Buy', content: <BuyPanel curveAddress={curveAddress} tokenAddress={tokenAddress} tokenDecimals={tokenDecimals} quoteAsset={quoteAsset} explorerBase={explorerBase} /> },
        { value: 'sell', label: 'Sell', content: <SellPanel curveAddress={curveAddress} tokenAddress={tokenAddress} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} quoteAsset={quoteAsset} explorerBase={explorerBase} /> },
      ]}
    />
  );
}
