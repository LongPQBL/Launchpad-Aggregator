'use client';

import type { Address } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';
import { erc20Abi } from './erc20Abi';

export interface TokenAllowance {
  allowance: bigint;
  isAllowanceLoading: boolean;
  approve: (amount: bigint) => void;
  isApproving: boolean;
  approveError: string | null;
}

export function useTokenAllowance(tokenAddress: Address | undefined, spender: Address | undefined): TokenAllowance {
  const { address: owner } = useAccount();
  const { data: allowance, isLoading, refetch } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled: Boolean(tokenAddress && owner && spender) },
  });
  const { writeContract, isPending, error } = useWriteContract();

  function approve(amount: bigint) {
    if (!tokenAddress || !spender) return;
    // Exact amount, never infinite — matches the spec's "Approval flow" default.
    writeContract({ address: tokenAddress, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }, { onSuccess: () => refetch() });
  }

  return {
    allowance: allowance ?? 0n,
    isAllowanceLoading: isLoading,
    approve,
    isApproving: isPending,
    approveError: error ? decodeTradeError(error) : null,
  };
}
