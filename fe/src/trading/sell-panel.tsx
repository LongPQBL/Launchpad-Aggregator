'use client';

import { useState } from 'react';
import { type Address, formatUnits, parseUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
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

export interface SellPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — see BuyPanelProps.tokenDecimals.
  tokenDecimals: number;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
}

function applySlippage(amount: bigint, slippageBps: number | 'auto'): bigint {
  const bps = slippageBps === 'auto' ? resolveAutoSlippageBps('curve') : slippageBps;
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function SellPanel({ curveAddress, tokenAddress, tokenDecimals, quoteAsset, explorerBase }: SellPanelProps) {
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;

  const amountIn = amount === '' ? 0n : parseUnits(amount, tokenDecimals);
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

  const hasInsufficientBalance = (tokenBalance ?? 0n) < amountIn;
  const needsApproval = amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  function submitSell() {
    if (amountIn === 0n || !account) return;
    const minQuoteOut = quote.outputAmount !== null ? applySlippage(quote.outputAmount, settings.slippageBps) : 0n;
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
        <p className="text-sm text-muted-foreground">Quote unavailable</p>
      ) : null}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {needsApproval ? (
        <Button type="button" disabled={allowance.isApproving || isWrongChain} onClick={() => allowance.approve(amountIn)}>
          {allowance.isApproving ? 'Approving…' : 'Approve'}
        </Button>
      ) : (
        <Button type="button" disabled={amountIn === 0n || hasInsufficientBalance || isWrongChain || quote.outputAmount === null} onClick={submitSell}>
          Sell
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
