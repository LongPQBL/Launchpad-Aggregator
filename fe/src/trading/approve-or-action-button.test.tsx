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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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

  it('shows a disabled "Getting quote…" instead of the action label when there is no quote output yet', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        quoteState="loading"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
        isSubmitting={false}
        allowance={baseAllowance()}
        actionLabel="Swap"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();
  });

  it('disables the action button while a submission is already in flight', () => {
    render(
      <ApproveOrActionButton
        needsApproval={false}
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="idle"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="loading"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="loading"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="loading"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
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
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
        isSubmitting={false}
        allowance={allowance}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(allowance.approve).toHaveBeenCalledWith(1_000n);
  });

  it('renders the action button instead of Approve when approval is needed but the wallet can batch calls', () => {
    const onAction = vi.fn();
    const allowance = baseAllowance();
    render(
      <ApproveOrActionButton
        needsApproval
        canBatchApprove
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
        isSubmitting={false}
        allowance={allowance}
        actionLabel="Swap"
        onAction={onAction}
      />,
    );
    const button = screen.getByRole('button', { name: 'Swap' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(allowance.approve).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows the approve error alert when present', () => {
    render(
      <ApproveOrActionButton
        needsApproval
        amountIn={1_000n}
        isWrongChain={false}
        hasInsufficientBalance={false}
        quoteState="ready"
        isConnected
        balanceKnown
        onConnect={vi.fn()}
        isSubmitting={false}
        allowance={baseAllowance({ approveError: 'Approval reverted' })}
        actionLabel="Buy"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval reverted');
  });
});

describe('ApproveOrActionButton states', () => {
  const baseProps = {
    isConnected: true, balanceKnown: true, quoteState: 'ready' as const, amountIn: 10n ** 18n, needsApproval: false,
    isWrongChain: false, hasInsufficientBalance: false, isSubmitting: false, allowance: baseAllowance(),
    actionLabel: 'Swap', onAction: vi.fn(), onConnect: vi.fn(),
  };
  it('shows Connect when disconnected, and clicking it calls onConnect', () => {
    const onConnect = vi.fn();
    render(<ApproveOrActionButton {...baseProps} isConnected={false} amountIn={0n} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
  it('does not call that a wrong network when no wallet is connected', () => {
    render(<ApproveOrActionButton {...baseProps} isConnected={false} isWrongChain />);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(screen.queryByText('Switch network')).not.toBeInTheDocument();
  });
  it('shows Getting quote… (disabled) while the quote is being simulated', () => {
    render(<ApproveOrActionButton {...baseProps} quoteState="loading" />);
    expect(screen.getByRole('button', { name: 'Getting quote…' })).toBeDisabled();
  });
  it('shows Not enough {symbol} (disabled) when the wallet cannot cover the amount', () => {
    render(<ApproveOrActionButton {...baseProps} hasInsufficientBalance tokenInSymbol="ETH" />);
    expect(screen.getByRole('button', { name: 'Not enough ETH' })).toBeDisabled();
  });
  it('shows Swap (enabled) when everything is ready, and calls onAction', () => {
    const onAction = vi.fn();
    render(<ApproveOrActionButton {...baseProps} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it('shows Quote unavailable (disabled) when no quote can be produced', () => {
    render(<ApproveOrActionButton {...baseProps} quoteState="unavailable" />);
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  });
});
