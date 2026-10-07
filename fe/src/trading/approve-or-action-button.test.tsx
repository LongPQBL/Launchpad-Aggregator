import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApproveOrActionButton, type ApproveOrActionAllowance } from './approve-or-action-button';

function baseAllowance(overrides: Partial<ApproveOrActionAllowance> = {}): ApproveOrActionAllowance {
  return {
    isApproving: false,
    isConfirmingApproval: false,
    approveError: null,
    approve: vi.fn(),
    ...overrides,
  };
}

describe('ApproveOrActionButton', () => {
  it('shows an Approve button that calls allowance.approve with amountIn when approval is needed', () => {
    const allowance = baseAllowance();
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={allowance}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Approve' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(allowance.approve).toHaveBeenCalledWith(1_000n);
  });

  it('shows "Approving…" while the wallet prompt is open and disables the button', () => {
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={baseAllowance({ isApproving: true })}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled();
  });

  it('shows "Confirming approval…" while the approval tx is mining and disables the button', () => {
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={baseAllowance({ isConfirmingApproval: true })}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirming approval…' })).toBeDisabled();
  });

  it('shows the action button with its label and calls onAction when approval is not needed', () => {
    const onAction = vi.fn();
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Sell"
        onAction={onAction}
      />,
    );
    const button = screen.getByRole('button', { name: 'Sell' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('disables the action button when there is no quote output yet', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={null}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('disables the action button while a submission is already in flight', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
  });

  it('shows a "Switch network" label and disables the button on the wrong chain', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeDisabled();
  });

  it('shows an "Enter an amount" label and disables the button when amountIn is zero', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={0n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={null}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  });

  it('shows a "Not enough {symbol}" label and disables the button when the balance is insufficient', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        tokenInSymbol="ETH"
        isWrongChain={false}
        hasInsufficientBalance
        outputAmount={null}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
  });

  it('falls back to "Not enough token" when tokenInSymbol is not given', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance
        outputAmount={null}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Not enough token' })).toBeDisabled();
  });

  it('prioritizes the wrong-chain label over an also-zero amount or insufficient balance', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={0n}
        isWrongChain
        hasInsufficientBalance
        outputAmount={null}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Switch network' })).toBeInTheDocument();
  });

  it('approves a separately-provided approveAmount instead of amountIn, when given one', () => {
    const allowance = baseAllowance();
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        approveAmount={2n ** 256n - 1n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={allowance}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(allowance.approve).toHaveBeenCalledWith(2n ** 256n - 1n);
  });

  it('falls back to approving amountIn when approveAmount is not given, unchanged from before', () => {
    const allowance = baseAllowance();
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={allowance}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(allowance.approve).toHaveBeenCalledWith(1_000n);
  });

  it('shows the approve error alert when present', () => {
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        outputAmount={500n}
        isSubmitting={false}
        allowance={baseAllowance({ approveError: 'Approval reverted' })}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval reverted');
  });
});
