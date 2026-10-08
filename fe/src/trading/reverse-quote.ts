import { decodeFunctionResult, encodeFunctionData, type Address, type StateOverride } from 'viem';
import { curveTradeAbi } from './curveAbi';
import { guessBuyInput, guessSellInput, readCurveState } from './curve-guess';
import {
  SIMULATION_ACCOUNT, discoverErc20Layouts, nativeBalanceOverride, spendStateOverride, type CallClient,
} from './erc20-state-override';
import { solveInputForOutput, type QuoteFn } from './solve-input-for-output';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import type { V4PoolKey } from './v4SwapEncoding';

// "Given the amount I want to receive, what exact-input amount do I need to send?" — one function
// per venue. Execution is always exact-input with the returned amount; see the spec's
// "Two-way quoting". null = no answer (revert / over capacity / RPC error) — never a guess.
export type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>;

// V3: the deployed QuoterV2 has a real exact-output quote (verified live on chain 4663), so this
// is a single call and no search.
export function makeV3ReverseSolve(
  client: CallClient,
  { tokenIn, tokenOut, fee }: { tokenIn: Address; tokenOut: Address; fee: number },
): ReverseSolve {
  return async (targetOut) => {
    try {
      const { data } = await client.call({
        to: V3_QUOTER_ADDRESS,
        data: encodeFunctionData({
          abi: v3QuoterAbi,
          functionName: 'quoteExactOutputSingle',
          args: [{ tokenIn, tokenOut, amount: targetOut, fee, sqrtPriceLimitX96: 0n }],
        }),
      });
      if (!data) return null;
      return decodeFunctionResult({ abi: v3QuoterAbi, functionName: 'quoteExactOutputSingle', data })[0];
    } catch {
      return null;
    }
  };
}

// V4: the deployed quoter exposes only exact-input (quoteExactInputSingleV4), so invert it.
export function makeV4ReverseSolve(
  client: CallClient,
  { poolKey, zeroForOne }: { poolKey: V4PoolKey; zeroForOne: boolean },
): ReverseSolve {
  const quote: QuoteFn = async (amountIn) => {
    try {
      const { data } = await client.call({
        to: V4_QUOTER_ADDRESS,
        data: encodeFunctionData({
          abi: v4QuoterAbi,
          functionName: 'quoteExactInputSingleV4',
          args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
        }),
      });
      if (!data) return null;
      return decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingleV4', data })[0];
    } catch {
      return null;
    }
  };
  return (targetOut, signal) => solveInputForOutput(quote, targetOut, { signal });
}

export interface CurveReverseParams {
  curveAddress: Address;
  direction: 'buy' | 'sell';
  tokenAddress: Address; // the launched token
  quoteAssetAddress: Address; // ignored when isNativeQuote
  isNativeQuote: boolean;
}

// Curve: no quote or exact-output view exists, so invert the real buy()/sell() simulation — it
// already includes every fee and the time/address-dependent snipe tax. The simulation runs as a
// synthetic account that is GIVEN (state override) the balance and the curve allowance it needs,
// so it works before the user approves and without a connected wallet. If the spent token's
// storage slots cannot be discovered, there is no answer (null) and no trade is simulated.
// The search starts from the exact constant-product model as a guess (see curve-guess.ts).
export function makeCurveReverseSolve(client: CallClient, params: CurveReverseParams): ReverseSolve {
  const { curveAddress, direction, tokenAddress, quoteAssetAddress, isNativeQuote } = params;
  return async (targetOut, signal) => {
    let stateOverride: StateOverride | null;
    if (direction === 'buy' && isNativeQuote) {
      stateOverride = nativeBalanceOverride(SIMULATION_ACCOUNT);
    } else {
      const spentToken = direction === 'buy' ? quoteAssetAddress : tokenAddress;
      const layouts = await discoverErc20Layouts(client, spentToken);
      stateOverride = spendStateOverride({ layouts, token: spentToken, owner: SIMULATION_ACCOUNT, spender: curveAddress });
    }
    if (!stateOverride || signal.aborted) return null;

    const quote: QuoteFn = async (amountIn) => {
      try {
        const { data } = await client.call({
          to: curveAddress,
          data: encodeFunctionData({ abi: curveTradeAbi, functionName: direction, args: [amountIn, 0n, SIMULATION_ACCOUNT] }),
          account: SIMULATION_ACCOUNT,
          value: direction === 'buy' && isNativeQuote ? amountIn : undefined,
          stateOverride,
        });
        if (!data) return null;
        return decodeFunctionResult({ abi: curveTradeAbi, functionName: direction, data });
      } catch {
        return null;
      }
    };

    const state = await readCurveState(client, curveAddress);
    const guess = state ? (direction === 'buy' ? guessBuyInput(state, targetOut) : guessSellInput(state, targetOut)) : null;
    return solveInputForOutput(quote, targetOut, { signal, initialGuess: guess ?? undefined });
  };
}
