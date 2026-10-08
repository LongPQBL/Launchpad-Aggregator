'use client';

import { useEffect, useRef } from 'react';

// useSimulateContract caches a pre-approval revert (e.g. the curve's transferFrom, or an
// ERC20's "STF" on a pool swap) under the same query key, since none of the quote's own inputs
// change across the approval — so once the approval actually confirms, the stale quote error
// must be explicitly refetched rather than relying on the hook's own (already-exhausted) retry
// budget. Used by curve-swap-panel.tsx, which pairs a useCurveQuote with a useTokenAllowance.
export function useRefetchQuoteAfterApproval(isConfirmingApproval: boolean, refetchQuote: () => void): void {
  const wasConfirmingApproval = useRef(false);
  useEffect(() => {
    if (wasConfirmingApproval.current && !isConfirmingApproval) {
      refetchQuote();
    }
    wasConfirmingApproval.current = isConfirmingApproval;
  }, [isConfirmingApproval, refetchQuote]);
}
