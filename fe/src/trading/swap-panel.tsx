'use client';

import { useEffect, useRef, useState } from 'react';
import { type Address, encodeFunctionData, formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { swapRouterAbi, SWAP_ROUTER_ADDRESS } from './swapRouterAbi';
import { usePoolFee } from './use-pool-fee';
import { useSwapQuote } from './use-swap-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { TradeStatus } from './trade-status';
import { applySlippage, parseAmountSafe } from './amount';

export interface SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
}

export interface SwapPanelProps {
  poolAddress: Address;
  tokenA: SwapToken;
  tokenB: SwapToken;
  explorerBase: string | null;
}

export function SwapPanel({ poolAddress, tokenA, tokenB, explorerBase }: SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const [amount, setAmount] = useState('');
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;
  const { fee } = usePoolFee(poolAddress);

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const amountIn = parseAmountSafe(amount, tokenIn.decimals);

  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });
  const allowance = useTokenAllowance(tokenIn.address, SWAP_ROUTER_ADDRESS);
  const quote = useSwapQuote({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee, amountIn, recipient: account });
  const submission = useTradeSubmission();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = (tokenInBalance ?? 0n) < amountIn;
  const needsApproval = amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  // useSimulateContract caches a pre-approval revert (e.g. "STF") under the same query key,
  // since none of tokenIn/tokenOut/fee/amountIn/recipient change across the approval — so once
  // the approval actually confirms, the stale quote error must be explicitly refetched rather
  // than relying on the hook's own (already-exhausted) retry budget. Same true-to-false
  // transition pattern as use-token-allowance.ts's own refetch-after-approval effect.
  const wasConfirmingApproval = useRef(false);
  const refetchQuote = quote.refetch;
  useEffect(() => {
    if (wasConfirmingApproval.current && !allowance.isConfirmingApproval) {
      refetchQuote();
    }
    wasConfirmingApproval.current = allowance.isConfirmingApproval;
  }, [allowance.isConfirmingApproval, refetchQuote]);

  function submitSwap() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    const amountOutMinimum = applySlippage(quote.outputAmount, settings.slippageBps, 'pool');
    // Floor the whole computed deadline, not just the current-timestamp half — a fractional
    // settings.deadlineMinutes (e.g. a user typed "1.01" into the settings popover) otherwise
    // makes the sum non-integer, and BigInt() throws a RangeError on a non-integer number.
    const deadline = BigInt(Math.floor(Date.now() / 1000 + settings.deadlineMinutes * 60));
    const innerCalldata = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: fee as number,
        recipient: account,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
    });
    submission.submit(
      { address: SWAP_ROUTER_ADDRESS, abi: swapRouterAbi, functionName: 'multicall', args: [deadline, [innerCalldata]] },
      { onSuccess: () => setAmount('') },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-sm">
          Sell {tokenIn.symbol ?? '—'}
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="pool" />
      </div>
      <Button type="button" variant="ghost" size="sm" aria-label="Flip swap direction"
        onClick={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); setAmount(''); }}>
        ⇅
      </Button>
      {quote.outputAmount !== null ? (
        <p className="text-sm text-muted-foreground">You receive ≈ {formatUnits(quote.outputAmount, tokenOut.decimals)} {tokenOut.symbol ?? ''}</p>
      ) : amountIn > 0n && quote.errorMessage ? (
        <p className="text-sm text-muted-foreground">Quote unavailable: {quote.errorMessage}</p>
      ) : null}
      {isWrongChain && <p className="text-sm text-destructive">Switch to Robinhood Chain to trade.</p>}
      {!isWrongChain && amountIn > 0n && hasInsufficientBalance && (
        <p className="text-sm text-destructive">Insufficient {tokenIn.symbol ?? 'token'} balance.</p>
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
          onClick={submitSwap}
        >
          Swap
        </Button>
      )}
      <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
    </div>
  );
}
