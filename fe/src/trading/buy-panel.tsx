'use client';

import { useEffect, useRef, useState } from 'react';
import { type Address, formatUnits, zeroAddress } from 'viem';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
import { erc20Abi } from './erc20Abi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { useCanBatchCalls } from './use-can-batch-calls';
import { useRefetchQuoteAfterApproval } from './use-refetch-quote-after-approval';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { applySlippage, parseAmountSafe } from './amount';

export interface BuyPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — NOT the quote asset's. Sourced from
  // LaunchDetail.tokenDecimals (Task 1); callers must not guess this.
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

export function BuyPanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: BuyPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = parseAmountSafe(amount, quoteAsset.decimals);
  const nativeBalance = useBalance({ address: account, query: { enabled: isNativeQuote && Boolean(account) } });
  const { data: quoteTokenBalance } = useReadContract({
    address: quoteAsset.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: !isNativeQuote && Boolean(account) },
  });
  const allowance = useTokenAllowance(isNativeQuote ? undefined : quoteAsset.address, isNativeQuote ? undefined : curveAddress);
  const quote = useCurveQuote({
    curveAddress,
    direction: 'buy',
    amountIn,
    recipient: account,
    nativeValue: isNativeQuote ? amountIn : undefined,
  });
  const submission = useTradeSubmission();
  const canBatch = useCanBatchCalls(settings.oneClickTradeOptIn);
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = isNativeQuote
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (quoteTokenBalance ?? 0n) < amountIn;
  // Don't prompt the user to approve an amount they're already known not to hold — mirrors
  // SellPanel's equivalent check.
  const needsApproval = !isNativeQuote && amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  useRefetchQuoteAfterApproval(allowance.isConfirmingApproval, quote.refetch);

  // A batched approve+buy confirms the ERC20->curve allowance without ever going through
  // allowance's own approve() (what its internal refetch-after-receipt watches for) — same
  // reasoning as swap-panel.tsx's identical guard, applied to the plain ERC20->curve approval.
  const wasConfirmed = useRef(false);
  useEffect(() => {
    if (!wasConfirmed.current && submission.status === 'confirmed') allowance.refetch();
    wasConfirmed.current = submission.status === 'confirmed';
  }, [submission.status, allowance]);

  function submitBuy() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const minTokensOut = applySlippage(quote.outputAmount, settings.slippageBps, 'curve');
    const buyCall = {
      address: curveAddress,
      abi: curveTradeAbi,
      functionName: 'buy',
      args: [amountIn, minTokensOut, account],
      value: isNativeQuote ? amountIn : undefined,
    };
    if (needsApproval && canBatch) {
      // Exact amountIn, never maxUint256 — matches useTokenAllowance's own approve() convention
      // for this plain ERC20->curve approval (unlike Permit2's always-maxUint256 approval).
      const approveCall = { address: quoteAsset.address, abi: erc20Abi, functionName: 'approve', args: [curveAddress, amountIn] };
      submission.submitBatch([approveCall, buyCall], { onSuccess: () => setAmount('') });
    } else {
      submission.submit(buyCall, { onSuccess: () => setAmount('') });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Amount ({quoteAsset.symbol ?? '—'})
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="curve" />
      </div>
      {quote.outputAmount !== null ? (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenDecimals)}</p>
      ) : amountIn > 0n && quote.errorMessage ? (
        <p className="text-sm text-muted-foreground">Quote unavailable: {quote.errorMessage}</p>
      ) : null}
      <ApproveOrActionButton
        needsApproval={needsApproval}
        amountIn={amountIn}
        isWrongChain={isWrongChain}
        hasInsufficientBalance={hasInsufficientBalance}
        tokenInSymbol={quoteAsset.symbol ?? undefined}
        canBatchApprove={canBatch}
        outputAmount={quote.outputAmount}
        isSubmitting={isSubmitting}
        allowance={allowance}
        actionLabel="Buy"
        onAction={submitBuy}
      />
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
