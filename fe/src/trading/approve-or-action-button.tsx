'use client';

import { Button } from '@/components/ui/button';

export interface ApproveOrActionAllowance {
  isApproving: boolean;
  isConfirmingApproval: boolean;
  approveError: string | null;
  approve: (amount: bigint) => void;
}

export interface ApproveOrActionButtonProps {
  needsApproval: boolean;
  amountIn: bigint;
  isWrongChain: boolean;
  hasInsufficientBalance: boolean;
  outputAmount: bigint | null;
  isSubmitting: boolean;
  allowance: ApproveOrActionAllowance;
  actionLabel: string;
  onAction: () => void;
}

// Shared by buy-panel.tsx, sell-panel.tsx, and swap-panel.tsx: each pairs a
// useTokenAllowance with its own quote/submission hooks, but the approve-vs-act decision
// and the approval-error alert were identical across all three.
export function ApproveOrActionButton({
  needsApproval,
  amountIn,
  isWrongChain,
  hasInsufficientBalance,
  outputAmount,
  isSubmitting,
  allowance,
  actionLabel,
  onAction,
}: ApproveOrActionButtonProps) {
  return (
    <>
      {allowance.approveError && (
        <p role="alert" className="text-sm text-destructive">
          {allowance.approveError}
        </p>
      )}
      {needsApproval ? (
        <Button
          type="button"
          disabled={allowance.isApproving || allowance.isConfirmingApproval || isWrongChain}
          onClick={() => allowance.approve(amountIn)}
        >
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : 'Approve'}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain || outputAmount === null || isSubmitting}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </>
  );
}
