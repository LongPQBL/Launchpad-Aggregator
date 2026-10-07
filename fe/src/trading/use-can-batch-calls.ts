'use client';

import { useAccount, useCapabilities } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';

// 'supported' is always trusted. EIP-5792 also defines 'ready' (the wallet could support atomic
// batching if the user opts in, not guaranteed) and 'unsupported'. Submitting a 'ready' wallet's
// batch is safe even without a guarantee: useTradeSubmission.submitBatch always sends
// `forceAtomic: true` (EIP-5792's `atomicRequired`), and per spec a wallet that can't execute
// atomically must reject that request outright, never execute it partially. So the only real
// question for 'ready' is UX, not safety — oneClickTradeOptIn is the user's own persisted
// "1-click trade" setting (trade-settings-popover.tsx) opting into attempting it anyway.
export function useCanBatchCalls(oneClickTradeOptIn = false): boolean {
  const { address } = useAccount();
  // Deliberately omits chainId: passing one makes viem's getCapabilities return only that chain's
  // entry (confirmed in node_modules/viem/_esm/actions/wallet/getCapabilities.js), silently
  // discarding EIP-5792 v2's chain-agnostic capability entry (reported under the numeric key 0,
  // from the wallet's 0x0 response key) that some wallets use instead of, or alongside, a
  // per-chain entry. Fetching the full map and checking both keys catches either form.
  const { data } = useCapabilities({
    account: address,
    query: { enabled: Boolean(address) },
  });
  function isBatchable(status: 'supported' | 'ready' | 'unsupported' | undefined): boolean {
    return status === 'supported' || (oneClickTradeOptIn && status === 'ready');
  }
  return isBatchable(data?.[robinhoodChain.id]?.atomic?.status) || isBatchable(data?.[0]?.atomic?.status);
}
