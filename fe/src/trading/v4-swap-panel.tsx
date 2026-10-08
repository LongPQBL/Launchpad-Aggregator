'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Address, formatUnits, maxUint256, zeroAddress } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContract } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { useV4SwapQuote } from './use-v4-swap-quote';
import { usePermit2Permit } from './use-permit2-permit';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { useTradeSubmission } from './use-trade-submission';
import { ApproveOrActionButton } from './approve-or-action-button';
import { openWalletDialog } from '@/wallet/open-wallet-dialog';
import { TradeStatus } from './trade-status';
import { useCanBatchCalls } from './use-can-batch-calls';
import { usePaymasterCapability } from './use-paymaster-capability';
import { PAYMASTER_SERVICE_URL } from './paymasterConfig';
import { TokenSelector } from './token-selector';
import { applySlippage } from './amount';
import { makeV4ReverseSolve } from './reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import { TradeCard } from './trade-card';
import { SwapShell } from './swap-shell';
import { usdText, usdPriceFor, type UsdPrices } from './trade-usd';
import { minReceivedText } from './trade-amount-format';
import { deriveQuoteState } from './trade-button-state';
import { encodeExecuteCommands, encodePermit2PermitInput, encodeV4SwapInput, type V4PoolKey } from './v4SwapEncoding';

export interface V4SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
  // Optional so callers without a known logo pass nothing; the selector falls back to a letter avatar.
  logoUri?: string | null;
}

export interface V4SwapPanelProps {
  poolKey: V4PoolKey;
  tokenA: V4SwapToken;
  tokenB: V4SwapToken;
  explorerBase: string | null;
  usdPrices?: UsdPrices;
}

export function V4SwapPanel({ poolKey, tokenA, tokenB, explorerBase, usdPrices }: V4SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const { address: account, chainId, isConnected } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const zeroForOne = tokenIn.address.toLowerCase() === poolKey.currency0.toLowerCase();
  const isNativeIn = tokenIn.address === zeroAddress;
  const client = usePublicClient({ chainId: robinhoodChain.id });
  const solve = useMemo(
    () => (client ? makeV4ReverseSolve(client, { poolKey, zeroForOne }) : null),
    // poolKey is a prop object whose identity can change every parent render — key on primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks, zeroForOne],
  );
  const amounts = useSwapAmounts({
    tokenInDecimals: tokenIn.decimals,
    tokenOutDecimals: tokenOut.decimals,
    solve,
    solveKey: `v4:${poolKey.currency0}:${poolKey.currency1}:${poolKey.fee}:${poolKey.tickSpacing}:${poolKey.hooks}:${zeroForOne}`,
  });
  const amountIn = amounts.amountIn;

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
  const canBatch = useCanBatchCalls(settings.oneClickTradeOptIn);
  const paymasterCapable = usePaymasterCapability();
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
      // Unset in every real environment today (paymasterConfig.ts) — see use-paymaster-capability.ts.
      const capabilities = PAYMASTER_SERVICE_URL && paymasterCapable ? { paymasterService: { url: PAYMASTER_SERVICE_URL } } : undefined;
      submission.submitBatch([approveCall, executeCall], { onSuccess: () => amounts.reset() }, capabilities);
    } else {
      submission.submit(executeCall, { onSuccess: () => amounts.reset() });
    }
  }

  const buyText = amounts.source === 'buy'
    ? amounts.buyTypedText
    : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
  const reverseUnavailable = amounts.source === 'buy' && amounts.reverseStatus === 'unavailable';
  const sellHint = reverseUnavailable ? 'Quote unavailable'
    : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
  const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
    ? `Quote unavailable: ${quote.errorMessage}` : null;
  const priceFor = (token: V4SwapToken) => usdPriceFor(usdPrices, token.address);
  const quoteState = deriveQuoteState({ source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn, outputAmount: quote.outputAmount, errorMessage: quote.errorMessage });
  const fixedSelector = (token: V4SwapToken) => {
    const option = { key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri ?? null };
    return <TokenSelector options={[option]} selected={option} onSelect={() => {}} chainId={robinhoodChain.id} />;
  };

  return (
    <SwapShell venueLabel="Uniswap V4 pool" venueKind="pool" settings={settings} onSettingsChange={update}>
      <TradeCard
        sell={{
          value: amounts.sellText, onChange: amounts.onSellChange, ariaLabel: 'Sell amount',
          selector: fixedSelector(tokenIn),
          usdText: usdText(amountIn, tokenIn.decimals, priceFor(tokenIn)), hint: sellHint,
        }}
        buy={{
          value: buyText, onChange: amounts.onBuyChange, ariaLabel: 'Buy amount',
          selector: fixedSelector(tokenOut),
          usdText: usdText(quote.outputAmount, tokenOut.decimals, priceFor(tokenOut)), hint: buyHint,
        }}
        onFlip={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); amounts.flip(); }}
        minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'pool', tokenOut.decimals, tokenOut.symbol)}
        footer={<>
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
            // While the ERC20->Permit2 allowance read is loading it reads back as 0n (unknown), so
            // hold the button in 'loading' — but only once an amount is typed, so an empty panel
            // still reads "Enter an amount".
            quoteState={amountIn > 0n && erc20Allowance.isAllowanceLoading ? 'loading' : quoteState}
            isConnected={isConnected}
            balanceKnown={isNativeIn ? nativeBalance.data !== undefined : tokenInBalance !== undefined}
            onConnect={openWalletDialog}
            isSubmitting={isSubmitting || permit2.isSigning}
            allowance={erc20Allowance}
            actionLabel="Swap"
            onAction={() => { void submitSwap(); }}
          />
          <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
        </>}
      />
    </SwapShell>
  );
}
