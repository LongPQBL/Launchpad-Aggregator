'use client';

import { useQueries } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { zeroAddress, type Address } from 'viem';
import { checkTokenFee, feeWarning, type SimulateClient } from './token-fee-check';
import { WETH_ADDRESS } from './v3SwapEncoding';

export interface FeeCheckedToken { address: Address; symbol: string | null }

const isCheckable = (address: Address) => address !== zeroAddress && address.toLowerCase() !== WETH_ADDRESS.toLowerCase();

/**
 * A warning when a token in the pair takes a fee or refuses to move (see token-fee-check.ts), measured by simulation on
 * the pool's own holdings. null while measuring or when there is nothing to say. A token that could not be measured gets a
 * plain note instead of silence: "not checked" must not read as "no fee".
 */
export function useTokenFeeWarning(tokens: readonly FeeCheckedToken[], holder: Address | null): string | null {
  const client = usePublicClient();
  const checkable = tokens.filter((token) => isCheckable(token.address));
  const results = useQueries({
    queries: checkable.map((token) => ({
      queryKey: ['token-fee-check', token.address.toLowerCase(), holder?.toLowerCase() ?? null],
      queryFn: () => checkTokenFee(client as unknown as SimulateClient, token.address, holder as Address),
      enabled: Boolean(client) && holder !== null,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const messages: string[] = [];
  results.forEach((result, index) => {
    const symbol = checkable[index].symbol ?? 'This token';
    if (!result.data) return;
    if (result.data.status === 'unchecked') messages.push(`Could not check whether ${symbol} charges a transfer fee.`);
    else { const warning = feeWarning(result.data, symbol); if (warning) messages.push(warning); }
  });
  return messages.length > 0 ? messages.join(' ') : null;
}
