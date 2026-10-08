'use client';

import { Button } from '@/components/ui/button';
import { resolveTradeButton, type QuoteState } from './trade-button-state';

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
  // back to the generic "token" when not given (every current panel passes one).
  tokenInSymbol?: string;
  // When true, a wallet that supports EIP-5792 atomic call batching skips the plain Approve step
  // and goes straight to the action button — onAction is responsible for bundling the approve
  // call into the batch itself. Defaults falsy, so omitting it preserves today's behavior exactly.
  canBatchApprove?: boolean;
  quoteState: QuoteState;
  isConnected: boolean;
  // False while the sold token's balance is still loading.
  balanceKnown: boolean;
  onConnect: () => void;
  isSubmitting: boolean;
  allowance: ApproveOrActionAllowance;
  actionLabel: string;
  onAction: () => void;
}

// Shared by curve-swap-panel.tsx, swap-panel.tsx, and v4-swap-panel.tsx: each pairs a
// useTokenAllowance with its own quote/submission hooks, but the approve-vs-act decision and the
// approval-error alert are identical across all three.
//
// The label itself communicates the blocking reason (wrong chain / no amount / insufficient
// balance), matching Uniswap's own convention, so callers no longer render a separate red warning
// paragraph for those same three conditions above this button.
export function ApproveOrActionButton(props: ApproveOrActionButtonProps) {
  const { needsApproval, amountIn, approveAmount, isWrongChain, hasInsufficientBalance, tokenInSymbol, canBatchApprove,
    quoteState, isConnected, balanceKnown, onConnect, isSubmitting, allowance, actionLabel, onAction } = props;
  const state = resolveTradeButton({ isConnected, isWrongChain, amountIn, quoteState, balanceKnown, hasInsufficientBalance,
    needsApproval, canBatchApprove: Boolean(canBatchApprove), tokenInSymbol });
  const approveError = allowance.approveError && (
    <p role="alert" className="text-sm text-destructive">{allowance.approveError}</p>
  );

  if (state.kind === 'connect') {
    return <Button type="button" className="cursor-pointer" onClick={onConnect}>{state.label}</Button>;
  }
  if (state.kind === 'approve') {
    return (
      <>
        {approveError}
        <Button type="button" className="cursor-pointer"
          disabled={allowance.isApproving || allowance.isConfirmingApproval}
          onClick={() => allowance.approve(approveAmount ?? amountIn)}>
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : state.label}
        </Button>
      </>
    );
  }
  return (
    <>
      {approveError}
      <Button type="button" className="cursor-pointer" disabled={state.disabled || (state.kind === 'swap' && isSubmitting)}
        onClick={state.kind === 'swap' ? onAction : undefined}>
        {state.kind === 'swap' ? actionLabel : state.label}
      </Button>
    </>
  );
}
