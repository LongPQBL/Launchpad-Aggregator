'use client';

import { useState } from 'react';
import { type Address, formatUnits, parseUnits, zeroAddress } from 'viem';
import { useAccount, useBalance } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { curveTradeAbi } from './curveAbi';
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

export function BuyPanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: BuyPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = amount === '' ? 0n : parseUnits(amount, quoteAsset.decimals);
  const nativeBalance = useBalance({ address: account, query: { enabled: isNativeQuote && Boolean(account) } });
  const allowance = useTokenAllowance(isNativeQuote ? undefined : quoteAsset.address, isNativeQuote ? undefined : curveAddress);
  const quote = useCurveQuote({
    curveAddress,
    direction: 'buy',
    amountIn,
    recipient: account,
    nativeValue: isNativeQuote ? amountIn : undefined,
  });
  const submission = useTradeSubmission();

  const needsApproval = !isNativeQuote && amountIn > 0n && allowance.allowance < amountIn;
  const hasInsufficientBalance = isNativeQuote && (nativeBalance.data?.value ?? 0n) < amountIn;

  function submitBuy() {
    if (amountIn === 0n || !account) return;
    const minTokensOut = quote.outputAmount !== null ? applySlippage(quote.outputAmount, settings.slippageBps) : 0n;
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
      {quote.outputAmount !== null && (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenDecimals)}</p>
      )}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {needsApproval ? (
        <Button type="button" disabled={allowance.isApproving || isWrongChain} onClick={() => allowance.approve(amountIn)}>
          {allowance.isApproving ? 'Approving…' : 'Approve'}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain || quote.outputAmount === null}
          onClick={submitBuy}
        >
          Buy
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
