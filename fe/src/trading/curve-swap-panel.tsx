'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Address, formatUnits, zeroAddress } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContract } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';
import { openWalletDialog } from '@/wallet/open-wallet-dialog';
import { curveTradeAbi } from './curveAbi';
import { erc20Abi } from './erc20Abi';
import { useCurveQuote } from './use-curve-quote';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { useTradeSubmission } from './use-trade-submission';
import { useCanBatchCalls } from './use-can-batch-calls';
import { usePaymasterCapability } from './use-paymaster-capability';
import { PAYMASTER_SERVICE_URL } from './paymasterConfig';
import { useRefetchQuoteAfterApproval } from './use-refetch-quote-after-approval';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { applySlippage } from './amount';
import { makeCurveReverseSolve } from './reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import { SwapShell } from './swap-shell';
import { TradeCard } from './trade-card';
import { TokenSelector } from './token-selector';
import { usdPriceFor, usdText, type UsdPrices } from './trade-usd';
import { minReceivedText } from './trade-amount-format';
import { deriveQuoteState } from './trade-button-state';

export interface CurveSwapPanelProps {
  curveAddress: Address;
  tokenAddress: Address;
  // The launched token's own decimals — NOT the quote asset's.
  tokenDecimals: number;
  tokenSymbol?: string | null;
  tokenLogoUri?: string | null;
  quoteAsset: { address: Address; symbol: string | null; decimals: number };
  explorerBase: string | null;
  usdPrices?: UsdPrices;
}

interface PanelToken {
  address: Address;
  symbol: string | null;
  decimals: number;
  logoUri: string | null;
}

export function CurveSwapPanel({
  curveAddress, tokenAddress, tokenDecimals, tokenSymbol, tokenLogoUri, quoteAsset, explorerBase, usdPrices,
}: CurveSwapPanelProps) {
  // 'buy' = quote asset -> launched token (curve.buy); 'sell' = launched token -> quote (curve.sell).
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const { address: account, chainId, isConnected } = useAccount();
  const { settings, update } = useTradeSettings();
  const isNativeQuote = quoteAsset.address === zeroAddress;
  const isWrongChain = chainId !== robinhoodChain.id;

  const launched: PanelToken = { address: tokenAddress, symbol: tokenSymbol ?? null, decimals: tokenDecimals, logoUri: tokenLogoUri ?? null };
  // The launch detail does not carry a quote-asset logo today, so the selector shows a letter avatar.
  const quoteTok: PanelToken = { address: quoteAsset.address, symbol: quoteAsset.symbol, decimals: quoteAsset.decimals, logoUri: null };
  const tokenIn = direction === 'buy' ? quoteTok : launched;
  const tokenOut = direction === 'buy' ? launched : quoteTok;

  const client = usePublicClient({ chainId: robinhoodChain.id });
  // No dependence on the connected account: the reverse quote simulates as a synthetic account.
  const solve = useMemo(
    () => (client
      ? makeCurveReverseSolve(client, { curveAddress, direction, tokenAddress, quoteAssetAddress: quoteAsset.address, isNativeQuote })
      : null),
    [client, curveAddress, direction, tokenAddress, quoteAsset.address, isNativeQuote],
  );
  const amounts = useSwapAmounts({
    tokenInDecimals: tokenIn.decimals,
    tokenOutDecimals: tokenOut.decimals,
    solve,
    solveKey: `curve:${curveAddress}:${direction}`,
  });
  const amountIn = amounts.amountIn;

  // Balance of whatever is being sold: native ETH when buying with a native quote, otherwise an
  // ERC20 balanceOf on the quote asset (buy) or the launched token (sell).
  const sellsNative = direction === 'buy' && isNativeQuote;
  const nativeBalance = useBalance({ address: account, query: { enabled: sellsNative && Boolean(account) } });
  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: !sellsNative && Boolean(account) },
  });
  const allowance = useTokenAllowance(sellsNative ? undefined : tokenIn.address, sellsNative ? undefined : curveAddress);
  const quote = useCurveQuote({
    curveAddress,
    direction,
    amountIn,
    recipient: account,
    nativeValue: sellsNative ? amountIn : undefined,
  });
  const submission = useTradeSubmission();
  const canBatch = useCanBatchCalls(settings.oneClickTradeOptIn);
  const paymasterCapable = usePaymasterCapability();
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

  const hasInsufficientBalance = sellsNative
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (tokenInBalance ?? 0n) < amountIn;
  // Don't prompt the user to approve an amount they're already known not to hold.
  const needsApproval = !sellsNative && amountIn > 0n && !hasInsufficientBalance && allowance.allowance < amountIn;

  useRefetchQuoteAfterApproval(allowance.isConfirmingApproval, quote.refetch);

  // A batched approve+trade confirms the ERC20->curve allowance without ever going through
  // allowance's own approve() (what its internal refetch-after-receipt watches for).
  const wasConfirmed = useRef(false);
  useEffect(() => {
    if (!wasConfirmed.current && submission.status === 'confirmed') allowance.refetch();
    wasConfirmed.current = submission.status === 'confirmed';
  }, [submission.status, allowance]);

  function submitTrade() {
    if (amountIn === 0n || !account || quote.outputAmount === null) return;
    // minTokensOut when buying, minQuoteOut when selling.
    const minOut = applySlippage(quote.outputAmount, settings.slippageBps, 'curve');
    const tradeCall = direction === 'buy'
      ? { address: curveAddress, abi: curveTradeAbi, functionName: 'buy', args: [amountIn, minOut, account], value: isNativeQuote ? amountIn : undefined }
      : { address: curveAddress, abi: curveTradeAbi, functionName: 'sell', args: [amountIn, minOut, account] };
    if (needsApproval && canBatch) {
      // Exact amountIn, never maxUint256 — matches useTokenAllowance's own approve() convention
      // for this plain ERC20->curve approval (unlike Permit2's always-maxUint256 approval).
      const approveCall = { address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [curveAddress, amountIn] };
      // Unset in every real environment today (paymasterConfig.ts) — see use-paymaster-capability.ts.
      const capabilities = PAYMASTER_SERVICE_URL && paymasterCapable ? { paymasterService: { url: PAYMASTER_SERVICE_URL } } : undefined;
      submission.submitBatch([approveCall, tradeCall], { onSuccess: () => amounts.reset() }, capabilities);
    } else {
      submission.submit(tradeCall, { onSuccess: () => amounts.reset() });
    }
  }

  const quoteState = deriveQuoteState({ source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn, outputAmount: quote.outputAmount, errorMessage: quote.errorMessage });
  const buyText = amounts.source === 'buy'
    ? amounts.buyTypedText
    : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
  const reverseUnavailable = amounts.source === 'buy' && amounts.reverseStatus === 'unavailable';
  const sellHint = reverseUnavailable ? 'Quote unavailable'
    : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
  const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
    ? `Quote unavailable: ${quote.errorMessage}` : null;
  const priceFor = (token: PanelToken) => usdPriceFor(usdPrices, token.address);
  const fixedSelector = (token: PanelToken) => {
    const option = { key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri };
    return <TokenSelector options={[option]} selected={option} onSelect={() => {}} chainId={robinhoodChain.id} />;
  };

  return (
    <SwapShell venueLabel="Bonding curve" venueKind="curve" settings={settings} onSettingsChange={update}>
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
        onFlip={() => { setDirection(direction === 'buy' ? 'sell' : 'buy'); amounts.flip(); }}
        minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'curve', tokenOut.decimals, tokenOut.symbol)}
        footer={<>
          <ApproveOrActionButton
            needsApproval={needsApproval}
            amountIn={amountIn}
            isWrongChain={isWrongChain}
            hasInsufficientBalance={hasInsufficientBalance}
            tokenInSymbol={tokenIn.symbol ?? undefined}
            canBatchApprove={canBatch}
            quoteState={quoteState}
            isConnected={isConnected}
            balanceKnown={sellsNative ? nativeBalance.data !== undefined : tokenInBalance !== undefined}
            onConnect={openWalletDialog}
            isSubmitting={isSubmitting}
            allowance={allowance}
            actionLabel="Swap"
            onAction={submitTrade}
          />
          <TradeStatus status={submission.status} txHash={submission.txHash} errorMessage={submission.errorMessage} explorerBase={explorerBase} />
        </>}
      />
    </SwapShell>
  );
}
