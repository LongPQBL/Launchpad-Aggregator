'use client';

import { useEffect } from 'react';
import type { Address } from 'viem';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { decodeTradeError } from './decodeTradeError';
import { erc20Abi } from './erc20Abi';

export interface TokenAllowance {
  allowance: bigint;
  isAllowanceLoading: boolean;
  approve: (amount: bigint) => void;
  // Wallet prompt open — the write has not been broadcast yet.
  isApproving: boolean;
  // Broadcast but not yet mined — distinct from isApproving so callers can show
  // "Confirming approval…" instead of implying the wallet prompt is still open.
  isConfirmingApproval: boolean;
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
  const { writeContract, isPending, error, data: approveTxHash } = useWriteContract();
  const { status: receiptStatus } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: Boolean(approveTxHash) },
  });

  // Only refetch once the approval actually confirms on-chain — not on broadcast,
  // which is what the previous onSuccess-on-write-success behavior effectively did.
  useEffect(() => {
    if (receiptStatus === 'success') refetch();
  }, [receiptStatus, refetch]);

  function approve(amount: bigint) {
    if (!tokenAddress || !spender) return;
    // Exact amount, never infinite — matches the spec's "Approval flow" default.
    writeContract({ address: tokenAddress, abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  }

  return {
    allowance: allowance ?? 0n,
    isAllowanceLoading: isLoading,
    approve,
    isApproving: isPending,
    isConfirmingApproval: Boolean(approveTxHash) && receiptStatus === 'pending',
    approveError: error ? decodeTradeError(error) : null,
  };
}
