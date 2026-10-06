'use client';

import { useState } from 'react';
import { type Address, formatUnits, parseUnits, zeroAddress } from 'viem';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
import { erc20Abi } from './erc20Abi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings, resolveAutoSlippageBps } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { TradeStatus } from './trade-status';

export interface BuyPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — NOT the quote asset's. Sourced from
  // LaunchDetail.tokenDecimals (Task 1); callers must not guess this.
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

// This panel only ever trades the bonding curve (see Task 9's gating) — no venueKind parameter
// to thread through until a pool-swap follow-up plan actually needs one.
function applySlippage(amount: bigint, slippageBps: number | 'auto'): bigint {
  const bps = slippageBps === 'auto' ? resolveAutoSlippageBps('curve') : slippageBps;
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

// A plain decimal string only — rejects scientific notation ("1e5") and anything else
// viem's parseUnits would throw on. This runs during render (computing amountIn), so a
// throw here would crash the whole page, not just this panel.
function parseAmountSafe(amount: string, decimals: number): bigint {
  if (amount === '' || !/^\d*\.?\d*$/.test(amount)) return 0n;
  try {
    return parseUnits(amount, decimals);
  } catch {
    return 0n;
  }
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
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = isNativeQuote
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (quoteTokenBalance ?? 0n) < amountIn;
  // Don't prompt the user to approve an amount they're already known not to hold — mirrors
  // SellPanel's equivalent check.
  const needsApproval = !isNativeQuote && amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  function submitBuy() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const minTokensOut = applySlippage(quote.outputAmount, settings.slippageBps);
    submission.submit(
      {
        address: curveAddress,
        abi: curveTradeAbi,
        functionName: 'buy',
        args: [amountIn, minTokensOut, account],
        value: isNativeQuote ? amountIn : undefined,
      },
      { onSuccess: () => setAmount('') },
    );
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
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {!isWrongChain && amountIn > 0n && hasInsufficientBalance && (
        <p className="text-sm text-destructive">Insufficient {quoteAsset.symbol ?? 'quote asset'} balance.</p>
      )}
      {allowance.approveError && (
        <p role="alert" className="text-sm text-destructive">
          {allowance.approveError}
        </p>
      )}
      {needsApproval ? (
        <Button
          type="button"
          disabled={allowance.isApproving || allowance.isConfirmingApproval || isWrongChain}
          onClick={() => allowance.approve(amountIn)}
        >
          {allowance.isApproving ? 'Approving…' : allowance.isConfirmingApproval ? 'Confirming approval…' : 'Approve'}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain || quote.outputAmount === null || isSubmitting}
          onClick={submitBuy}
        >
          Buy
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
