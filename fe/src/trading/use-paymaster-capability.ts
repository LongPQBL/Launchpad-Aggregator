'use client';

import { useAccount, useCapabilities } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';

// Almost no wallet reports this today without being a smart-contract wallet (e.g. Coinbase Smart
// Wallet) or EIP-7702-upgraded — this hook only detects wallet-side support, it does not make a
// wallet support it, and paymasterConfig.ts's URL is unset in every real environment until a
// funded Alchemy Gas Manager (or ZeroDev) policy exists for Robinhood Chain.
export function usePaymasterCapability(): boolean {
  const { address } = useAccount();
  // Same chain-agnostic-key-0 reasoning as use-can-batch-calls.ts's identical pattern.
  const { data } = useCapabilities({
    account: address,
    query: { enabled: Boolean(address) },
  });
  return Boolean(data?.[robinhoodChain.id]?.paymasterService?.supported) || Boolean(data?.[0]?.paymasterService?.supported);
}
