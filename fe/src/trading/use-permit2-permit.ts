'use client';

import type { Address, Hex } from 'viem';
import { useAccount, useReadContract, useSignTypedData } from 'wagmi';
import { permit2Abi, PERMIT2_ADDRESS } from './permit2Abi';
import { decodeTradeError } from './decodeTradeError';
import type { PermitSingle } from './v4SwapEncoding';

export interface Permit2PermitResult {
  needsPermit: boolean;
  isAllowanceLoading: boolean;
  signPermit: () => Promise<{ permitSingle: PermitSingle; signature: Hex } | null>;
  isSigning: boolean;
  signError: string | null;
}

// Both windows are deliberately short-lived: the signed amount is always exactly the trade's own
// amountIn (never maxUint256 — see Global Constraints), so once a swap consumes it the remaining
// allowance is already zero regardless of how long expiration lasts; a short window just avoids
// leaving even that exact-amount allowance sitting around if the user signs but never submits.
const PERMIT_WINDOW_SECONDS = 30 * 60;

// Plain helper, not a hook — keeping the impure Date.now() read out of the hook body itself
// matches this codebase's existing convention (see formatAge in launch-list.tsx, poolAge in
// pool-list.tsx) and satisfies eslint's react-hooks/purity rule, which only inspects the
// component/hook function's own body, not helpers it calls.
function isAllowanceSufficient(amount: bigint, expiration: number, amountIn: bigint): boolean {
  return amount >= amountIn && expiration > Math.floor(Date.now() / 1000);
}

function permitWindow(): number {
  return Math.floor(Date.now() / 1000) + PERMIT_WINDOW_SECONDS;
}

export function usePermit2Permit(tokenAddress: Address | undefined, spender: Address | undefined, amountIn: bigint): Permit2PermitResult {
  const { address: owner, chainId } = useAccount();
  const { data, isLoading, refetch } = useReadContract({
    address: PERMIT2_ADDRESS,
    abi: permit2Abi,
    functionName: 'allowance',
    args: owner && tokenAddress && spender ? [owner, tokenAddress, spender] : undefined,
    query: { enabled: Boolean(owner && tokenAddress && spender) },
  });
  const { signTypedDataAsync, isPending, error } = useSignTypedData();

  const [amount, expiration, nonce] = data ?? [0n, 0, 0];
  const needsPermit = amountIn > 0n && !isAllowanceSufficient(amount, expiration, amountIn);

  async function signPermit() {
    if (!owner || !tokenAddress || !spender || !chainId) return null;
    // Permit2.permit() reverts with InvalidNonce unless the signed nonce exactly matches the
    // current on-chain value, and every successful permit() call increments it. Since the signed
    // amount is always exactly amountIn (never a standing allowance — see PERMIT_WINDOW_SECONDS'
    // comment above), a second swap of the same token in one session must not reuse the render-time
    // `data` captured at mount/last-render: it may already be stale. Fetch a genuinely fresh value
    // right before constructing and signing the PermitSingle.
    const fresh = await refetch();
    if (!fresh.data) return null;
    const [, , freshNonce] = fresh.data;
    const expiresAt = permitWindow();
    const permitSingle: PermitSingle = {
      details: { token: tokenAddress, amount: amountIn, expiration: expiresAt, nonce: freshNonce },
      spender,
      sigDeadline: BigInt(expiresAt),
    };
    const signature = await signTypedDataAsync({
      domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
      types: {
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
      },
      primaryType: 'PermitSingle',
      message: permitSingle,
    });
    return { permitSingle, signature };
  }

  return {
    needsPermit,
    isAllowanceLoading: isLoading,
    signPermit,
    isSigning: isPending,
    signError: error ? decodeTradeError(error) : null,
  };
}
