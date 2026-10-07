'use client';

import { useState } from 'react';
import { type Address, type Hex, formatUnits, maxUint256 } from 'viem';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { robinhoodChain } from '@/wallet/config';
import { erc20Abi } from './erc20Abi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from './universalRouterAbi';
import { PERMIT2_ADDRESS } from './permit2Abi';
import { usePoolFee } from './use-pool-fee';
import { useV3SwapQuote } from './use-v3-swap-quote';
import { usePermit2Permit } from './use-permit2-permit';
import { useTokenAllowance } from './use-token-allowance';
import { useTradeSettings } from './use-trade-settings';
import { TradeSettingsPopover } from './trade-settings-popover';
import { useTradeSubmission } from './use-trade-submission';
import { ApproveOrActionButton } from './approve-or-action-button';
import { TradeStatus } from './trade-status';
import { TokenSelector, type TokenSelectorOption } from './token-selector';
import { applySlippage, parseAmountSafe } from './amount';
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
}

function isWeth(token: SwapToken): boolean {
  return token.address.toLowerCase() === WETH_ADDRESS.toLowerCase();
}

export function SwapPanel({ poolAddress, tokenA, tokenB, explorerBase }: SwapPanelProps) {
  const [direction, setDirection] = useState<'aToB' | 'bToA'>('aToB');
  const [amount, setAmount] = useState('');
  // Governs the ETH/WETH choice on whichever side currently holds the WETH leg (if any) — a
  // single boolean, not per-direction, since flipping direction only changes whether that leg
  // is currently "in" or "out", never which side it's on. Irrelevant when neither tokenA nor
  // tokenB is WETH.
  const [useNativeEth, setUseNativeEth] = useState(true);
  const { address: account, chainId } = useAccount();
  const { settings, update } = useTradeSettings();
  const isWrongChain = chainId !== robinhoodChain.id;
  const { fee } = usePoolFee(poolAddress);

  const tokenIn = direction === 'aToB' ? tokenA : tokenB;
  const tokenOut = direction === 'aToB' ? tokenB : tokenA;
  const amountIn = parseAmountSafe(amount, tokenIn.decimals);

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
  const isSubmitting = submission.status === 'pending' || submission.status === 'confirming';

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

    submission.submit(
      {
        address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute',
        args: [commands, inputs, deadline],
        value: nativeIn ? amountIn : undefined,
      },
      { onSuccess: () => setAmount('') },
    );
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="flex-1 text-sm">Sell</span>
        <TradeSettingsPopover settings={settings} onChange={update} venueKind="pool" />
      </div>
      <div className="relative flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <Input aria-label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} className="flex-1" />
          <TokenSelector
            options={sideOptions(tokenIn)}
            selected={selectedOption(tokenIn)}
            onSelect={(key) => handleSelect(tokenIn, key)}
            chainId={robinhoodChain.id}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex-1 text-sm text-muted-foreground">
            {quote.outputAmount !== null
              ? `You receive ≈ ${formatUnits(quote.outputAmount, tokenOut.decimals)} ${displaySymbol(tokenOut, nativeOut)}`
              : amountIn > 0n && quote.errorMessage ? `Quote unavailable: ${quote.errorMessage}` : ''}
          </span>
          <TokenSelector
            options={sideOptions(tokenOut)}
            selected={selectedOption(tokenOut)}
            onSelect={(key) => handleSelect(tokenOut, key)}
            chainId={robinhoodChain.id}
          />
        </div>
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
        tokenInSymbol={displaySymbol(tokenIn, nativeIn)}
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
