'use client';

import { type Address, formatUnits, zeroAddress } from 'viem';
import { useBalance, useReadContract } from 'wagmi';
import type { PoolSummary } from '@/api/client';
import { erc20Abi } from '@/trading/erc20Abi';
import { robinhoodChain } from '@/wallet/config';

const compactAmount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function useSideBalance(poolAddress: Address, token: { address: Address; decimals: number | null }, enabled: boolean) {
  const isNative = token.address.toLowerCase() === zeroAddress;
  const native = useBalance({ address: poolAddress, chainId: robinhoodChain.id, query: { enabled: enabled && isNative } });
  const erc20 = useReadContract({
    address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress], chainId: robinhoodChain.id,
    query: { enabled: enabled && !isNative },
  });
  const raw = isNative ? native.data?.value : erc20.data;
  return raw === undefined || token.decimals === null ? null : Number(formatUnits(raw, token.decimals));
}

export interface PoolBalancesProps {
  protocol: string;
  poolAddress: Address;
  displayed: { address: Address; symbol: string | null; decimals: number | null };
  other: { address: Address; symbol: string | null; decimals: number | null };
  priceInQuote: string | null;
  poolBalances: PoolSummary['poolBalances'];
}

function amountFromRaw(raw: bigint | string, decimals: number | null): number | null {
  if (decimals === null) return null;
  try {
    const amount = Number(formatUnits(typeof raw === 'bigint' ? raw : BigInt(raw), decimals));
    return Number.isFinite(amount) ? amount : null;
  } catch { return null; }
}

export function PoolBalances({ protocol, poolAddress, displayed, other, priceInQuote, poolBalances }: PoolBalancesProps) {
  const decimalsKnown = displayed.decimals !== null && other.decimals !== null;
  const enabled = protocol !== 'uniswap_v4' && decimalsKnown;
  const onchainDisplayedAmount = useSideBalance(poolAddress, displayed, enabled);
  const onchainOtherAmount = useSideBalance(poolAddress, other, enabled);

  if (!decimalsKnown) {
    return <p className="text-sm text-muted-foreground">Pool balances unavailable: token decimals unknown</p>;
  }

  let displayedAmount = onchainDisplayedAmount;
  let otherAmount = onchainOtherAmount;
  let compositionPrice = priceInQuote;
  if (protocol === 'uniswap_v4') {
    if (!poolBalances) return <p className="text-sm text-muted-foreground">Pool balances unavailable</p>;
    displayedAmount = amountFromRaw(poolBalances.displayedAmountRaw, displayed.decimals);
    otherAmount = amountFromRaw(poolBalances.otherAmountRaw, other.decimals);
    compositionPrice = poolBalances.priceInQuote;
  }

  if (displayedAmount === null || otherAmount === null) {
    return <p className="text-sm text-muted-foreground">{protocol === 'uniswap_v4' ? 'Pool balances unavailable' : 'Loading pool balances…'}</p>;
  }

  // Both sides in `other`-quote terms, same convention as this page's own "Price in {quote}"
  // figure, so the bar reflects relative value, not relative token count (1 ETH vs 100M tokens
  // would otherwise always paint the bar as 100% one color).
  const price = compositionPrice === null ? null : Number(compositionPrice);
  const displayedValue = price === null ? null : displayedAmount * price;
  const otherValue = otherAmount;
  const total = displayedValue === null ? null : displayedValue + otherValue;
  const displayedPercent = total === null || !Number.isFinite(total) || !Number.isFinite(displayedValue)
    || price === 0 ? null
    : total === 0 ? 50 : Math.min(100, Math.max(0, (displayedValue! / total) * 100));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-lg font-semibold">
        <span>{compactAmount.format(displayedAmount)} {displayed.symbol ?? ''}</span>
        <span>{compactAmount.format(otherAmount)} {other.symbol ?? ''}</span>
      </div>
      {displayedPercent !== null && (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Pool composition">
          <div className="h-full bg-lime-400" style={{ width: `${displayedPercent}%` }} />
          <div className="h-full bg-indigo-400" style={{ width: `${100 - displayedPercent}%` }} />
        </div>
      )}
    </div>
  );
}
