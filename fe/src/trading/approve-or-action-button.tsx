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
  // Defaults to amountIn when omitted — both SwapPanel and V4SwapPanel need this to differ (they
  // always approve maxUint256 to Permit2, while amountIn keeps meaning the real trade amount for
  // the action button's own disabled check below).
  approveAmount?: bigint;
  isWrongChain: boolean;
  hasInsufficientBalance: boolean;
  // Symbol of the token amountIn is denominated in, for the "Not enough {symbol}" label. Falls
  // back to the generic "token" when not given (e.g. sell-panel.tsx doesn't thread one through yet).
  tokenInSymbol?: string;
  outputAmount: bigint | null;
  isSubmitting: boolean;
  allowance: ApproveOrActionAllowance;
  actionLabel: string;
  onAction: () => void;
}

// Shared by buy-panel.tsx, sell-panel.tsx, swap-panel.tsx, and v4-swap-panel.tsx: each pairs a
// useTokenAllowance with its own quote/submission hooks, but the approve-vs-act decision and the
// approval-error alert were identical across all four.
//
// The label itself communicates the blocking reason (wrong chain / no amount / insufficient
// balance), matching Uniswap's own convention, so callers no longer render a separate red warning
// paragraph for those same three conditions above this button.
export function ApproveOrActionButton({
  needsApproval,
  amountIn,
  approveAmount,
  isWrongChain,
  hasInsufficientBalance,
  tokenInSymbol,
  outputAmount,
  isSubmitting,
  allowance,
  actionLabel,
  onAction,
}: ApproveOrActionButtonProps) {
  const approveError = allowance.approveError && (
    <p role="alert" className="text-sm text-destructive">
      {allowance.approveError}
    </p>
  );

  if (isWrongChain || amountIn === 0n || hasInsufficientBalance) {
    const label = isWrongChain ? 'Switch network' : amountIn === 0n ? 'Enter an amount' : `Not enough ${tokenInSymbol ?? 'token'}`;
    return (
      <>
        {approveError}
        <Button type="button" disabled>{label}</Button>
      </>
    );
  }

  if (needsApproval) {
    return (
      <>
        {approveError}
        <Button
          type="button"
          disabled={allowance.isApproving || allowance.isConfirmingApproval}
          onClick={() => allowance.approve(approveAmount ?? amountIn)}
        >
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : 'Approve'}
        </Button>
      </>
    );
  }

  return (
    <>
      {approveError}
      <Button type="button" disabled={outputAmount === null || isSubmitting} onClick={onAction}>
        {actionLabel}
      </Button>
    </>
  );
}
