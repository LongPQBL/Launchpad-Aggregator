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

  it('disables the action button on the wrong chain', () => {
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
    expect(screen.getByRole('button', { name: 'Swap' })).toBeDisabled();
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
