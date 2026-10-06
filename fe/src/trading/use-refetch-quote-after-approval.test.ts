import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRefetchQuoteAfterApproval } from './use-refetch-quote-after-approval';

describe('useRefetchQuoteAfterApproval', () => {
  it('refetches the quote once isConfirmingApproval transitions from true to false', () => {
    const refetchQuote = vi.fn();
    const { rerender } = renderHook(
      ({ isConfirmingApproval }: { isConfirmingApproval: boolean }) =>
        useRefetchQuoteAfterApproval(isConfirmingApproval, refetchQuote),
      { initialProps: { isConfirmingApproval: false } },
    );
    expect(refetchQuote).not.toHaveBeenCalled();

    rerender({ isConfirmingApproval: true });
    expect(refetchQuote).not.toHaveBeenCalled();

    rerender({ isConfirmingApproval: false });
    expect(refetchQuote).toHaveBeenCalledTimes(1);
  });

  it('does not refetch on mount or on a false-to-false transition', () => {
    const refetchQuote = vi.fn();
    const { rerender } = renderHook(
      ({ isConfirmingApproval }: { isConfirmingApproval: boolean }) =>
        useRefetchQuoteAfterApproval(isConfirmingApproval, refetchQuote),
      { initialProps: { isConfirmingApproval: false } },
    );
    rerender({ isConfirmingApproval: false });
    expect(refetchQuote).not.toHaveBeenCalled();
  });
});
