import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { curveStateAbi } from './curveAbi';
import {
  curveBuyOutput, curveSellOutput, guessBuyInput, guessSellInput, readCurveState, type CurveState,
} from './curve-guess';
import { decodeFunctionData } from 'viem';
import { encodeResult, makeFakeClient } from './test-support/fake-call-client';

// Reserves and fee read from the live OBUL curve on chain 4663; the expected outputs below are the
// real eth_call simulation results at that same state (see the task intro).
const live: CurveState = { quoteReserve: 1680047904858931814n, tokenReserve: 999971486016087261842747212n, feeBps: 100n };

describe('curve closed-form model matches the live simulations exactly', () => {
  it.each([
    [10n ** 15n, 588905085539402016855496n],
    [5n * 10n ** 15n, 2937605347464235929523175n],
    [10n ** 17n, 55646155927117960995515549n],
  ])('buy %s -> %s', (amountIn, expected) => {
    expect(curveBuyOutput(live, amountIn)).toBe(expected);
  });

  it.each([
    [10n ** 18n, 1663294851n],
    [10n ** 21n, 1663293189632n],
    [10n ** 15n, 1663295n],
  ])('sell %s -> %s', (tokensIn, expected) => {
    expect(curveSellOutput(live, tokensIn)).toBe(expected);
  });
});

describe('guesses invert the model closely', () => {
  it('guessBuyInput lands within 0.01% of the real input', () => {
    const g = guessBuyInput(live, 588905085539402016855496n)!;
    expect(Number(g - 10n ** 15n) / 1e15).toBeLessThan(1e-4);
    expect(Number(10n ** 15n - g) / 1e15).toBeLessThan(1e-4);
  });
  it('guessSellInput lands within 0.01% of the real input', () => {
    const g = guessSellInput(live, 1663294851n)!;
    expect(Math.abs(Number(g - 10n ** 18n)) / 1e18).toBeLessThan(1e-4);
  });
  it('returns null (no guess) for impossible targets', () => {
    expect(guessBuyInput(live, 0n)).toBeNull();
    expect(guessBuyInput(live, live.tokenReserve)).toBeNull(); // cannot buy the whole reserve
    expect(guessBuyInput({ ...live, feeBps: 10_000n }, 1n)).toBeNull();
    expect(guessSellInput(live, 0n)).toBeNull();
    expect(guessSellInput(live, live.quoteReserve)).toBeNull(); // cannot drain the quote reserve
  });
});

describe('readCurveState', () => {
  const curve = '0x4444444444444444444444444444444444444444' as Address;
  it('reads the reserves and the fee', async () => {
    const client = makeFakeClient(({ data }) => {
      const { functionName } = decodeFunctionData({ abi: curveStateAbi, data });
      const value = functionName === 'quoteReserve' ? live.quoteReserve : functionName === 'tokenReserve' ? live.tokenReserve : live.feeBps;
      return encodeResult(curveStateAbi, functionName, value);
    });
    expect(await readCurveState(client, curve)).toEqual(live);
  });
  it('returns null when any read fails', async () => {
    const client = makeFakeClient(() => { throw new Error('revert'); });
    expect(await readCurveState(client, curve)).toBeNull();
  });
});
