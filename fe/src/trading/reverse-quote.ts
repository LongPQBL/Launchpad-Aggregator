import { decodeFunctionResult, encodeFunctionData, type Address, type StateOverride } from 'viem';
import { curveTradeAbi } from './curveAbi';
import { guessBuyInput, guessSellInput, readCurveState } from './curve-guess';
import {
  SIMULATION_ACCOUNT, discoverErc20Layouts, nativeBalanceOverride, spendStateOverride, type CallClient,
} from './erc20-state-override';
import { isNoAnswerError } from './rpc-errors';
import { solveInputForOutput, type QuoteFn } from './solve-input-for-output';
import { v2PairAbi } from './v2PairAbi';
import { v2AmountIn } from './v2-math';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import type { V4PoolKey } from './v4SwapEncoding';

// "Given the amount I want to receive, what exact-input amount do I need to send?" — one function
// per venue. Execution is always exact-input with the returned amount; see the spec's
// "Two-way quoting". null = no answer (revert / over capacity) — never a guess. A transport error
// (timeout, HTTP) or a programming error (e.g. an invalid address) rejects instead, so it is never
// mistaken for a revert; the caller shows "unavailable" for a rejection.
export type ReverseSolve = (targetOut: bigint, signal: AbortSignal) => Promise<bigint | null>;

// Runs one simulation: a revert / undecodable result is null ("no answer"); a transport or
// programming error propagates (see rpc-errors.ts).
async function callOrNull(run: () => Promise<bigint | null>): Promise<bigint | null> {
  try {
    return await run();
  } catch (error) {
    if (isNoAnswerError(error)) return null;
    throw error;
  }
}

// V3: the deployed QuoterV2 has a real exact-output quote (verified live on chain 4663), so this
// is a single call and no search.
export function makeV3ReverseSolve(
  client: CallClient,
  { tokenIn, tokenOut, fee }: { tokenIn: Address; tokenOut: Address; fee: number },
): ReverseSolve {
  return async (targetOut) => {
    const data = encodeFunctionData({
      abi: v3QuoterAbi,
      functionName: 'quoteExactOutputSingle',
      args: [{ tokenIn, tokenOut, amount: targetOut, fee, sqrtPriceLimitX96: 0n }],
    });
    return callOrNull(async () => {
      const { data: out } = await client.call({ to: V3_QUOTER_ADDRESS, data });
      if (!out) return null;
      return decodeFunctionResult({ abi: v3QuoterAbi, functionName: 'quoteExactOutputSingle', data: out })[0];
    });
  };
}

// V2: the reserves fix the price, so "what must I send to receive X" is the library's own closed form (rounded up), read fresh each time.
export function makeV2ReverseSolve(
  client: CallClient,
  { pair, tokenIn }: { pair: Address; tokenIn: Address },
): ReverseSolve {
  return async (targetOut) => {
    const [reservesOut, token0Out] = await Promise.all([
      client.call({ to: pair, data: encodeFunctionData({ abi: v2PairAbi, functionName: 'getReserves' }) }),
      client.call({ to: pair, data: encodeFunctionData({ abi: v2PairAbi, functionName: 'token0' }) }),
    ]);
    if (!reservesOut.data || !token0Out.data) return null;
    const [reserve0, reserve1] = decodeFunctionResult({ abi: v2PairAbi, functionName: 'getReserves', data: reservesOut.data });
    const token0 = decodeFunctionResult({ abi: v2PairAbi, functionName: 'token0', data: token0Out.data });
    const inIsToken0 = token0.toLowerCase() === tokenIn.toLowerCase();
    return v2AmountIn(targetOut, inIsToken0 ? reserve0 : reserve1, inIsToken0 ? reserve1 : reserve0);
  };
}

const MAX_UINT128 = (1n << 128n) - 1n;

// V4: the deployed quoter exposes only exact-input (quoteExactInputSingle), so invert it.
export function makeV4ReverseSolve(
  client: CallClient,
  { poolKey, zeroForOne }: { poolKey: V4PoolKey; zeroForOne: boolean },
): ReverseSolve {
  const quote: QuoteFn = async (amountIn) => {
    return callOrNull(async () => {
      // exactAmount is a uint128; a search probe above that range simply has no quote.
      if (amountIn > MAX_UINT128) return null;
      const data = encodeFunctionData({
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
      });
      const { data: out } = await client.call({ to: V4_QUOTER_ADDRESS, data });
      if (!out) return null;
      return decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: out })[0];
    });
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
// The state override a curve simulation needs so the synthetic account can trade: native balance for a native-quoted buy, otherwise the spent
// token's balance and the curve allowance. null = the token's storage layout could not be found, so there is no answer.
async function curveSimulationOverride(client: CallClient, params: CurveReverseParams): Promise<StateOverride | null> {
  const { curveAddress, direction, tokenAddress, quoteAssetAddress, isNativeQuote } = params;
  if (direction === 'buy' && isNativeQuote) return nativeBalanceOverride(SIMULATION_ACCOUNT);
  const spentToken = direction === 'buy' ? quoteAssetAddress : tokenAddress;
  const layouts = await discoverErc20Layouts(client, spentToken);
  return spendStateOverride({ layouts, token: spentToken, owner: SIMULATION_ACCOUNT, spender: curveAddress });
}

// Exact-input curve quote without a wallet: the real buy()/sell() simulated as the synthetic account (so every fee and the snipe tax are
// included). null = no answer (revert, or no way to fund the synthetic account); a transport error rejects.
export function makeCurveForwardQuote(client: CallClient, params: CurveReverseParams): (amountIn: bigint) => Promise<bigint | null> {
  const { curveAddress, direction, isNativeQuote } = params;
  let override: Promise<StateOverride | null> | null = null;
  return async (amountIn) => {
    override ??= curveSimulationOverride(client, params);
    let stateOverride: StateOverride | null;
    try { stateOverride = await override; } catch (error) { override = null; throw error; }
    if (!stateOverride) return null;
    const data = encodeFunctionData({ abi: curveTradeAbi, functionName: direction, args: [amountIn, 0n, SIMULATION_ACCOUNT] });
    return callOrNull(async () => {
      const { data: out } = await client.call({
        to: curveAddress, data, account: SIMULATION_ACCOUNT,
        value: direction === 'buy' && isNativeQuote ? amountIn : undefined, stateOverride,
      });
      if (!out) return null;
      return decodeFunctionResult({ abi: curveTradeAbi, functionName: direction, data: out }) as bigint;
    });
  };
}

export function makeCurveReverseSolve(client: CallClient, params: CurveReverseParams): ReverseSolve {
  const { curveAddress, direction, isNativeQuote } = params;
  return async (targetOut, signal) => {
    const stateOverride = await curveSimulationOverride(client, params);
    if (!stateOverride || signal.aborted) return null;

    const quote: QuoteFn = async (amountIn) => {
      const data = encodeFunctionData({ abi: curveTradeAbi, functionName: direction, args: [amountIn, 0n, SIMULATION_ACCOUNT] });
      return callOrNull(async () => {
        const { data: out } = await client.call({
          to: curveAddress,
          data,
          account: SIMULATION_ACCOUNT,
          value: direction === 'buy' && isNativeQuote ? amountIn : undefined,
          stateOverride,
        });
        if (!out) return null;
        return decodeFunctionResult({ abi: curveTradeAbi, functionName: direction, data: out });
      });
    };

    const state = await readCurveState(client, curveAddress);
    const guess = state ? (direction === 'buy' ? guessBuyInput(state, targetOut) : guessSellInput(state, targetOut)) : null;
    return solveInputForOutput(quote, targetOut, { signal, initialGuess: guess ?? undefined });
  };
}
