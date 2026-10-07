'use client';

import { useEffect, useRef, useState } from 'react';
import { type Address, formatUnits, maxUint256, zeroAddress } from 'viem';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { useV4SwapQuote } from './use-v4-swap-quote';
import { usePermit2Permit } from './use-permit2-permit';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { useCanBatchCalls } from './use-can-batch-calls';
import { applySlippage, parseAmountSafe } from './amount';
import { encodeExecuteCommands, encodePermit2PermitInput, encodeV4SwapInput, type V4PoolKey } from './v4SwapEncoding';

export interface V4SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
}

export interface V4SwapPanelProps {
  poolKey: V4PoolKey;
  tokenA: V4SwapToken;
  tokenB: V4SwapToken;
  explorerBase: string | null;
}

export function V4SwapPanel({ poolKey, tokenA, tokenB, explorerBase }: V4SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const zeroForOne = tokenIn.address.toLowerCase() === poolKey.currency0.toLowerCase();
  const isNativeIn = tokenIn.address === zeroAddress;
  const amountIn = parseAmountSafe(amount, tokenIn.decimals);

  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) && !isNativeIn },
  });
  const nativeBalance = useBalance({ address: account, query: { enabled: isNativeIn && Boolean(account) } });
  const erc20Allowance = useTokenAllowance(isNativeIn ? undefined : tokenIn.address, PERMIT2_ADDRESS);
  const permit2 = usePermit2Permit(isNativeIn ? undefined : tokenIn.address, UNIVERSAL_ROUTER_ADDRESS, amountIn);
  const quote = useV4SwapQuote({ poolKey, zeroForOne, amountIn });
  const submission = useTradeSubmission();
  const canBatch = useCanBatchCalls();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  // A batched approve+swap confirms the ERC20->Permit2 approval without ever going through
  // erc20Allowance's own approve() (which is what its internal refetch-after-receipt is watching
  // for) — without this, the cached pre-batch allowance (0) stays stale, so a later swap of the
  // same token would wrongly believe approval is still needed and re-batch a redundant approve.
  // The ref-guarded edge trigger (not just "status === 'confirmed'") matches
  // use-refetch-quote-after-approval.ts's existing pattern: erc20Allowance.refetch is a fresh
  // closure every render, so depending on it directly would call refetch() on every re-render
  // while status stays 'confirmed', not just once per confirmation.
  const wasConfirmed = useRef(false);
  useEffect(() => {
    if (!wasConfirmed.current && submission.status === 'confirmed') erc20Allowance.refetch();
    wasConfirmed.current = submission.status === 'confirmed';
  }, [submission.status, erc20Allowance]);

  const hasInsufficientBalance = isNativeIn
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (tokenInBalance ?? 0n) < amountIn;
  const needsErc20Approval = !isNativeIn && amountIn > 0n && !hasInsufficientBalance && erc20Allowance.allowance < amountIn;

  async function submitSwap() {
    // Clear any stale signature-rejection error from a previous attempt as soon as a new submit
    // begins, regardless of outcome — otherwise a swap that needs no signature at all (e.g. an
    // existing allowance now covers it) would never call signTypedDataAsync again and the old
    // rejection message would keep showing even though this attempt is about to succeed.
    permit2.resetSignError();
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const amountOutMinimum = applySlippage(quote.outputAmount, settings.slippageBps, 'pool');

    let permitInput: `0x${string}` | null = null;
    if (!isNativeIn && permit2.needsPermit) {
      // signPermit() calls signTypedDataAsync, which throws when the user rejects the wallet's
      // signature request (or the wallet errors). submitSwap is invoked as `void submitSwap()`
      // from the UI, so an uncaught throw here would become an unhandled promise rejection. Just
      // stop — permit2.signError already reflects the rejection once useSignTypedData's own error
      // state updates, so there is nothing more to surface here.
      let signed;
      try {
        signed = await permit2.signPermit();
      } catch {
        return;
      }
      if (!signed) return;
      permitInput = encodePermit2PermitInput(signed.permitSingle, signed.signature);
    }

    const swapInput = encodeV4SwapInput({ poolKey, zeroForOne, amountIn, amountOutMinimum });
    const commands = encodeExecuteCommands({ needsPermit: permitInput !== null });
    const inputs = permitInput ? [permitInput, swapInput] : [swapInput];
    // Floor the whole computed deadline — a fractional settings.deadlineMinutes otherwise makes
    // the sum non-integer, and BigInt() throws a RangeError on a non-integer number (same fix
    // already applied in swap-panel.tsx for the identical bug shape).
    const deadline = BigInt(Math.floor(Date.now() / 1000 + settings.deadlineMinutes * 60));

    const executeCall = {
      address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute',
      args: [commands, inputs, deadline],
      value: isNativeIn ? amountIn : undefined,
    };

    if (needsErc20Approval && canBatch) {
      const approveCall = { address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] };
      submission.submitBatch([approveCall, executeCall], { onSuccess: () => setAmount('') });
    } else {
      submission.submit(executeCall, { onSuccess: () => setAmount('') });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="pool" />
      </div>
      <div className="relative flex flex-col gap-1">
        <label className="flex-1 text-sm">
          Sell {tokenIn.symbol ?? '—'}
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        {quote.outputAmount !== null ? (
          <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenOut.decimals)} {tokenOut.symbol ?? ''}</p>
        ) : amountIn > 0n && quote.errorMessage ? (
          <p className="text-sm text-muted-foreground">Quote unavailable: {quote.errorMessage}</p>
        ) : null}
        <Button type="button" variant="outline" size="sm" aria-label="Flip swap direction"
          className="absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-background p-0 shadow-sm"
          onClick={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); setAmount(''); }}>
          ⇅
        </Button>
      </div>
      {permit2.signError && (
        <p role="alert" className="text-sm text-destructive">
          {permit2.signError}
        </p>
      )}
      <ApproveOrActionButton
        needsApproval={needsErc20Approval}
        amountIn={amountIn}
        approveAmount={maxUint256}
        isWrongChain={isWrongChain}
        hasInsufficientBalance={hasInsufficientBalance}
        tokenInSymbol={tokenIn.symbol ?? undefined}
        canBatchApprove={canBatch}
        outputAmount={quote.outputAmount}
        isSubmitting={isSubmitting || permit2.isSigning}
        allowance={erc20Allowance}
        actionLabel="Swap"
        onAction={() => { void submitSwap(); }}
      />
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
