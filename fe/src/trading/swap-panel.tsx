'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Address, type Hex, formatUnits, maxUint256 } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContract } from 'wagmi';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { usePoolFee } from './use-pool-fee';
import { useV3SwapQuote } from './use-v3-swap-quote';
import { usePermit2Permit } from './use-permit2-permit';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { useTradeSubmission } from './use-trade-submission';
import { ApproveOrActionButton } from './approve-or-action-button';
import { openWalletDialog } from '@/wallet/open-wallet-dialog';
import { TradeStatus } from './trade-status';
import { TokenSelector, type TokenSelectorOption } from './token-selector';
import { useCanBatchCalls } from './use-can-batch-calls';
import { usePaymasterCapability } from './use-paymaster-capability';
import { PAYMASTER_SERVICE_URL } from './paymasterConfig';
import { applySlippage } from './amount';
import { makeV3ReverseSolve } from './reverse-quote';
import { useSwapAmounts } from './use-swap-amounts';
import { TradeCard } from './trade-card';
import { SwapShell } from './swap-shell';
import { usdText, usdPriceFor, type UsdPrices } from './trade-usd';
import { minReceivedText } from './trade-amount-format';
import { deriveQuoteState } from './trade-button-state';
import { encodePermit2PermitInput } from './v4SwapEncoding';
import {
  WETH_ADDRESS, MSG_SENDER, ADDRESS_THIS,
  encodeV3SwapInput, encodeWrapEthInput, encodeUnwrapWethInput, encodeExecuteCommands,
} from './v3SwapEncoding';

export interface SwapToken {
  address: Address;
  symbol: string | null;
  decimals: number;
  // null when no logo is known for this address — the token-selector falls back to a letter
  // avatar (TokenImage's existing behavior), never a guessed or fabricated URL.
  logoUri: string | null;
}

export interface SwapPanelProps {
  poolAddress: Address;
  tokenA: SwapToken;
  tokenB: SwapToken;
  explorerBase: string | null;
  usdPrices?: UsdPrices;
}

function isWeth(token: SwapToken): boolean {
  return token.address.toLowerCase() === WETH_ADDRESS.toLowerCase();
}

export function SwapPanel({ poolAddress, tokenA, tokenB, explorerBase, usdPrices }: SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  // Governs the ETH/WETH choice on whichever side currently holds the WETH leg (if any) — a
  // single boolean, not per-direction, since flipping direction only changes whether that leg
  // is currently "in" or "out", never which side it's on. Irrelevant when neither tokenA nor
  // tokenB is WETH.
  const [useNativeEth, setUseNativeEth] = useState(true);
  const { address: account, chainId, isConnected } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;
  const { fee } = usePoolFee(poolAddress);

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const client = usePublicClient({ chainId: robinhoodChain.id });
  const solve = useMemo(
    () => (client && fee !== null
      ? makeV3ReverseSolve(client, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee })
      : null),
    [client, fee, tokenIn.address, tokenOut.address],
  );
  const amounts = useSwapAmounts({
    tokenInDecimals: tokenIn.decimals,
    tokenOutDecimals: tokenOut.decimals,
    solve,
    solveKey: `v3:${poolAddress}:${tokenIn.address}:${tokenOut.address}:${fee}`,
  });
  const amountIn = amounts.amountIn;

  const nativeIn = useNativeEth && isWeth(tokenIn);
  const nativeOut = useNativeEth && isWeth(tokenOut);

  const { data: tokenInBalance } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) && !nativeIn },
  });
  const nativeBalance = useBalance({ address: account, query: { enabled: nativeIn && Boolean(account) } });
  const erc20Allowance = useTokenAllowance(nativeIn ? undefined : tokenIn.address, PERMIT2_ADDRESS);
  const permit2 = usePermit2Permit(nativeIn ? undefined : tokenIn.address, UNIVERSAL_ROUTER_ADDRESS, amountIn);
  const quote = useV3SwapQuote({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee, amountIn });
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

  const hasInsufficientBalance = nativeIn
    ? (nativeBalance.data?.value ?? 0n) < amountIn
    : (tokenInBalance ?? 0n) < amountIn;
  const needsErc20Approval = !nativeIn && amountIn > 0n && !hasInsufficientBalance && erc20Allowance.allowance < amountIn;

  function displaySymbol(token: SwapToken, isCurrentlyNative: boolean): string {
    if (isWeth(token) && isCurrentlyNative) return 'ETH';
    return token.symbol ?? 'token';
  }

  async function submitSwap() {
    // Clear any stale signature-rejection error from a previous attempt as soon as a new submit
    // begins, regardless of outcome — same reasoning as v4-swap-panel.tsx's identical guard.
    permit2.resetSignError();
    if (amountIn === 0n || !account || quote.outputAmount === null || fee === null) return;
    const amountOutMinimum = applySlippage(quote.outputAmount, settings.slippageBps, 'pool');

    let permitInput: Hex | null = null;
    if (!nativeIn && permit2.needsPermit) {
      // signPermit() calls signTypedDataAsync, which throws when the user rejects the wallet's
      // signature request. submitSwap is invoked as `void submitSwap()` from the UI, so an
      // uncaught throw here would become an unhandled promise rejection.
      let signed;
      try {
        signed = await permit2.signPermit();
      } catch {
        return;
      }
      if (!signed) return;
      permitInput = encodePermit2PermitInput(signed.permitSingle, signed.signature);
    }

    const swapInput = encodeV3SwapInput({
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee,
      amountIn,
      amountOutMinimum,
      payerIsUser: !nativeIn,
      recipient: nativeOut ? ADDRESS_THIS : MSG_SENDER,
    });
    const wrapInput = nativeIn ? encodeWrapEthInput({ recipient: ADDRESS_THIS, amountMinimum: amountIn }) : null;
    const unwrapInput = nativeOut ? encodeUnwrapWethInput({ recipient: MSG_SENDER, amountMinimum: amountOutMinimum }) : null;

    const commands = encodeExecuteCommands({ needsPermit: permitInput !== null, nativeIn, nativeOut });
    const inputs = [
      ...(permitInput ? [permitInput] : []),
      ...(wrapInput ? [wrapInput] : []),
      swapInput,
      ...(unwrapInput ? [unwrapInput] : []),
    ];
    // Floor the whole computed deadline, not just the current-timestamp half — a fractional
    // settings.deadlineMinutes otherwise makes the sum non-integer, and BigInt() throws a
    // RangeError on a non-integer number (same fix already applied in the V4 panel).
    const deadline = BigInt(Math.floor(Date.now() / 1000 + settings.deadlineMinutes * 60));

    const executeCall = {
      address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute',
      args: [commands, inputs, deadline],
      value: nativeIn ? amountIn : undefined,
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

  function sideOptions(token: SwapToken): readonly TokenSelectorOption[] {
    if (!isWeth(token)) return [{ key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri }];
    return [
      { key: 'eth', symbol: 'ETH', logoUri: null },
      { key: 'weth', symbol: 'WETH', logoUri: token.logoUri },
    ];
  }

  function selectedOption(token: SwapToken): TokenSelectorOption {
    if (!isWeth(token)) return { key: token.address, symbol: token.symbol ?? '—', logoUri: token.logoUri };
    return useNativeEth
      ? { key: 'eth', symbol: 'ETH', logoUri: null }
      : { key: 'weth', symbol: 'WETH', logoUri: token.logoUri };
  }

  function handleSelect(token: SwapToken, key: string) {
    // Selecting the pool's single fixed (non-WETH) token is a no-op — there is nothing else it
    // could become. Only a WETH-leg side's 'eth'/'weth' choice actually changes state, and it's
    // the one shared useNativeEth boolean regardless of which side (in or out) it's on.
    if (isWeth(token)) setUseNativeEth(key === 'eth');
  }

  const buyText = amounts.source === 'buy'
    ? amounts.buyTypedText
    : (quote.outputAmount !== null ? formatUnits(quote.outputAmount, tokenOut.decimals) : '');
  const reverseUnavailable = amounts.source === 'buy' && amounts.reverseStatus === 'unavailable';
  const sellHint = reverseUnavailable ? 'Quote unavailable'
    : amounts.source === 'buy' && amounts.reverseStatus === 'loading' ? 'Estimating…' : null;
  const buyHint = amounts.source === 'sell' && amountIn > 0n && quote.outputAmount === null && quote.errorMessage
    ? `Quote unavailable: ${quote.errorMessage}` : null;
  const priceFor = (token: SwapToken) => usdPriceFor(usdPrices, token.address);
  const quoteState = deriveQuoteState({ source: amounts.source, reverseStatus: amounts.reverseStatus, amountIn, outputAmount: quote.outputAmount, errorMessage: quote.errorMessage });

  return (
    <SwapShell venueLabel="Uniswap V3 pool" venueKind="pool" settings={settings} onSettingsChange={update}>
      <TradeCard
        sell={{
          value: amounts.sellText, onChange: amounts.onSellChange, ariaLabel: 'Sell amount',
          selector: (<TokenSelector options={sideOptions(tokenIn)} selected={selectedOption(tokenIn)} onSelect={(key) => handleSelect(tokenIn, key)} chainId={robinhoodChain.id} />),
          usdText: usdText(amountIn, tokenIn.decimals, priceFor(tokenIn)), hint: sellHint,
        }}
        buy={{
          value: buyText, onChange: amounts.onBuyChange, ariaLabel: 'Buy amount',
          selector: (<TokenSelector options={sideOptions(tokenOut)} selected={selectedOption(tokenOut)} onSelect={(key) => handleSelect(tokenOut, key)} chainId={robinhoodChain.id} />),
          usdText: usdText(quote.outputAmount, tokenOut.decimals, priceFor(tokenOut)), hint: buyHint,
        }}
        onFlip={() => { setDirection(direction === 'aToB' ? 'bToA' : 'aToB'); amounts.flip(); }}
        minReceived={minReceivedText(quote.outputAmount, settings.slippageBps, 'pool', tokenOut.decimals, displaySymbol(tokenOut, nativeOut))}
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
            tokenInSymbol={displaySymbol(tokenIn, nativeIn)}
            canBatchApprove={canBatch}
            quoteState={amountIn > 0n && erc20Allowance.isAllowanceLoading ? 'loading' : quoteState}
            isConnected={isConnected}
            balanceKnown={nativeIn ? nativeBalance.data !== undefined : tokenInBalance !== undefined}
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
