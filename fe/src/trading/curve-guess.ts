import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem';
import { curveStateAbi } from './curveAbi';
import type { CallClient } from './erc20-state-override';

// Constant-product curve with virtual reserves and a fee. Buy: the fee comes off the quote input;
// sell: the fee comes off the quote output, floored. Reproduces the real simulations exactly when
// no snipe tax / creator tax applies — which is why it is only ever a starting GUESS: the
// simulation is always the source of truth.
export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: bigint;
}

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function curveBuyOutput(state: CurveState, amountIn: bigint): bigint {
  const net = (amountIn * (BPS - state.feeBps)) / BPS;
  return (state.tokenReserve * net) / (state.quoteReserve + net);
}

export function curveSellOutput(state: CurveState, tokensIn: bigint): bigint {
  const gross = (state.quoteReserve * tokensIn) / (state.tokenReserve + tokensIn);
  return gross - (gross * state.feeBps) / BPS;
}

// Quote-asset input that should buy `targetTokensOut` tokens.
export function guessBuyInput(state: CurveState, targetTokensOut: bigint): bigint | null {
  if (targetTokensOut <= 0n || targetTokensOut >= state.tokenReserve || state.feeBps >= BPS) return null;
  const net = ceilDiv(state.quoteReserve * targetTokensOut, state.tokenReserve - targetTokensOut);
  return ceilDiv(net * BPS, BPS - state.feeBps);
}

// Token input that should sell for `targetQuoteOut` of the quote asset (after the fee).
export function guessSellInput(state: CurveState, targetQuoteOut: bigint): bigint | null {
  if (targetQuoteOut <= 0n || state.feeBps >= BPS) return null;
  const gross = ceilDiv(targetQuoteOut * BPS, BPS - state.feeBps);
  if (gross >= state.quoteReserve) return null;
  return ceilDiv(state.tokenReserve * gross, state.quoteReserve - gross);
}

export async function readCurveState(client: CallClient, curveAddress: Address): Promise<CurveState | null> {
  const read = async (functionName: 'quoteReserve' | 'tokenReserve' | 'feeBps'): Promise<bigint> => {
    const { data } = await client.call({ to: curveAddress, data: encodeFunctionData({ abi: curveStateAbi, functionName }) });
    if (!data) throw new Error('empty result');
    return decodeFunctionResult({ abi: curveStateAbi, functionName, data });
  };
  try {
    const [quoteReserve, tokenReserve, feeBps] = await Promise.all([read('quoteReserve'), read('tokenReserve'), read('feeBps')]);
    return { quoteReserve, tokenReserve, feeBps };
  } catch {
    return null;
  }
}
