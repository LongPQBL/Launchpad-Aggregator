'use client';

import { useState } from 'react';
import { type Address, formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
import { erc20Abi } from './erc20Abi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { useRefetchQuoteAfterApproval } from './use-refetch-quote-after-approval';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { applySlippage, parseAmountSafe } from './amount';

export interface SellPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — see BuyPanelProps.tokenDecimals.
  tokenDecimals: number;
  // The launched token's own symbol, for the "Not enough {symbol}" button label — distinct from
  // quoteAsset.symbol, since selling spends the launched token itself, not the quote asset.
  tokenSymbol?: string | null;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

export function SellPanel({ curveAddress, tokenAddress, tokenDecimals, tokenSymbol, quoteAsset, explorerBase }: SellPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = parseAmountSafe(amount, tokenDecimals);
  const { data: tokenBalance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });
  const allowance = useTokenAllowance(tokenAddress, curveAddress);
  const quote = useCurveQuote({ curveAddress, direction: 'sell', amountIn, recipient: account, nativeValue: undefined });
  const submission = useTradeSubmission();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = (tokenBalance ?? 0n) < amountIn;
  const needsApproval = amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  useRefetchQuoteAfterApproval(allowance.isConfirmingApproval, quote.refetch);

  function submitSell() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const minQuoteOut = applySlippage(quote.outputAmount, settings.slippageBps, 'curve');
    submission.submit(
      { address: curveAddress, abi: curveTradeAbi, functionName: 'sell', args: [amountIn, minQuoteOut, account] },
      { onSuccess: () => setAmount('') },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Amount
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="curve" />
      </div>
      {quote.outputAmount !== null ? (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, quoteAsset.decimals)} {quoteAsset.symbol ?? ''}</p>
      ) : amountIn > 0n && quote.errorMessage ? (
        <p className="text-sm text-muted-foreground">Quote unavailable: {quote.errorMessage}</p>
      ) : null}
      <ApproveOrActionButton
        needsApproval={needsApproval}
        amountIn={amountIn}
        isWrongChain={isWrongChain}
        hasInsufficientBalance={hasInsufficientBalance}
        tokenInSymbol={tokenSymbol ?? undefined}
        outputAmount={quote.outputAmount}
        isSubmitting={isSubmitting}
        allowance={allowance}
        actionLabel="Sell"
        onAction={submitSell}
      />
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
