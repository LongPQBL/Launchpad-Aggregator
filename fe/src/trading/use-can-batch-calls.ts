'use client';

import { useAccount, useCapabilities } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';

// Only 'supported' is trusted — EIP-5792 also defines 'ready' (the wallet could support atomic
// batching if the user opts in, not guaranteed) and 'unsupported'. Treating 'ready' as enough
// risks a wallet_sendCalls batch that doesn't execute atomically, which could land the approval
// without the swap.
export function useCanBatchCalls(): boolean {
  const { address } = useAccount();
  const { data } = useCapabilities({
    account: address,
    chainId: robinhoodChain.id,
    query: { enabled: Boolean(address) },
  });
  return data?.atomic?.status === 'supported';
}
