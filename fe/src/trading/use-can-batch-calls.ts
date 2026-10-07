'use client';

import { useAccount, useCapabilities } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';

// Only 'supported' is trusted — EIP-5792 also defines 'ready' (the wallet could support atomic
// batching if the user opts in, not guaranteed) and 'unsupported'. Treating 'ready' as enough
// risks a wallet_sendCalls batch that doesn't execute atomically, which could land the approval
// without the swap.
export function useCanBatchCalls(): boolean {
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
  return data?.[robinhoodChain.id]?.atomic?.status === 'supported' || data?.[0]?.atomic?.status === 'supported';
}
