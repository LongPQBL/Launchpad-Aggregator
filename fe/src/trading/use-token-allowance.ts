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
  // Lets a caller manually invalidate the cached allowance after a change this hook didn't itself
  // drive — e.g. a batched wallet_sendCalls approve+swap, which never calls this hook's own
  // approve() and so never triggers the receiptStatus-watching refetch below.
  refetch: () => void;
}

export function useTokenAllowance(tokenAddress: Address | undefined, spender: Address | undefined): TokenAllowance {
  const { address: owner } = useAccount();
  const { data: allowance, isLoading, isFetching, refetch } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled: Boolean(tokenAddress && owner && spender) },
  });
  const { writeContract, isPending, error, data: approveTxHash } = useWriteContract();
  const { status: receiptStatus, error: receiptError } = useWaitForTransactionReceipt({
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

  // Prefer the receipt error — a mined-but-reverted approval is a later, more specific failure
  // than whatever the wallet-write step reported (which may not have errored at all).
  const reportedError = receiptError ?? error;

  return {
    allowance: allowance ?? 0n,
    isAllowanceLoading: isLoading,
    approve,
    isApproving: isPending,
    // Covers both "broadcast but not yet mined" and "mined, allowance refetch still in flight" —
    // isFetching is TanStack Query's own live refetch indicator (gated on approveTxHash existing
    // so it never fires on this hook's very first, pre-approval allowance load). Without the
    // second half, needsApproval briefly reads the stale pre-approval allowance for one RPC round
    // trip and the Approve button comes back clickable (final review, Important 1's exact gap).
    isConfirmingApproval: Boolean(approveTxHash) && (receiptStatus === 'pending' || isFetching),
    approveError: reportedError ? decodeTradeError(reportedError) : null,
    refetch: () => { void refetch(); },
  };
}
