'use client';

import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { zeroAddress, type Address } from 'viem';
import { checkTokenFee, feeWarning, type SimulateClient } from './token-fee-check';
import { WETH_ADDRESS } from './v3SwapEncoding';

export interface FeeCheckedToken { address: Address; symbol: string | null; amount?: bigint | null }

const isCheckable = (address: Address) => address !== zeroAddress && address.toLowerCase() !== WETH_ADDRESS.toLowerCase();
const safeReason = (reason: string) => reason
  .replace(/(?:https?|wss?):\/\/\S+/gi, '[RPC endpoint]')
  .replace(/\s+/g, ' ')
  .slice(0, 120);

/**
 * A warning when a token in the pair takes a fee or refuses to move (see token-fee-check.ts), measured by simulation on
 * the pool's own holdings. null while measuring or when there is nothing to say. A token that could not be measured gets a
 * plain note instead of silence: "not checked" must not read as "no fee".
 */
export function useTokenFeeWarning(tokens: readonly FeeCheckedToken[], holder: Address | null): string | null {
  const client = usePublicClient();
  const checkable = tokens.filter((token) => isCheckable(token.address) && token.amount !== null && token.amount !== undefined && token.amount > 0n);
  const inputKey = checkable.map((token) => `${token.address.toLowerCase()}:${token.amount}`).join('|');
  const [settledKey, setSettledKey] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettledKey(inputKey), 350);
    return () => clearTimeout(timer);
  }, [inputKey]);
  const results = useQueries({
    queries: checkable.map((token) => ({
      queryKey: ['token-fee-check', token.address.toLowerCase(), holder?.toLowerCase() ?? null, token.amount?.toString()],
      queryFn: () => checkTokenFee(client as unknown as SimulateClient, token.address, holder as Address, { amount: token.amount ?? undefined }),
      enabled: Boolean(client) && holder !== null && inputKey === settledKey,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const messages: string[] = [];
  results.forEach((result, index) => {
    const symbol = checkable[index].symbol ?? 'This token';
    if (!result.data) return;
    if (result.data.status === 'unchecked') messages.push(`Could not check whether ${symbol} charges a transfer fee (${safeReason(result.data.reason)}).`);
    else { const warning = feeWarning(result.data, symbol); if (warning) messages.push(warning); }
  });
  return messages.length > 0 ? messages.join(' ') : null;
}
