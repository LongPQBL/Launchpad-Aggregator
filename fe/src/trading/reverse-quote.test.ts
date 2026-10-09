import { beforeEach, describe, expect, it } from 'vitest';
import {
  CallExecutionError, HttpRequestError, InvalidAddressError, RpcRequestError, TimeoutError, decodeFunctionData, encodeFunctionData, parseAbi,
  type Address, type Hex,
} from 'viem';
import { curveStateAbi, curveTradeAbi } from './curveAbi';
import { curveBuyOutput, curveSellOutput, type CurveState } from './curve-guess';
import {
  SIMULATION_ACCOUNT, allowanceSlotAt, balanceSlotAt, clearErc20LayoutCache,
} from './erc20-state-override';
import { makeCurveReverseSolve, makeV3ReverseSolve, makeV4ReverseSolve } from './reverse-quote';
import { V3_QUOTER_ADDRESS, v3QuoterAbi } from './v3QuoterAbi';
import { V4_QUOTER_ADDRESS, v4QuoterAbi } from './v4QuoterAbi';
import { encodeResult, makeFakeClient, type FakeCallRequest } from './test-support/fake-call-client';

const signal = new AbortController().signal;
const transport = () => new CallExecutionError(new TimeoutError({ body: {}, url: 'https://rpc.example' }), {});
const revert = (message = 'execution reverted') => new RpcRequestError({ body: {}, url: 'https://rpc.example', error: { code: 3, message } });
const curve = '0x4444444444444444444444444444444444444444' as Address;
const launched = '0x2222222222222222222222222222222222222222' as Address;
const quoteToken = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const tokenOut = '0x3333333333333333333333333333333333333333' as Address;
const poolKey = { currency0: launched, currency1: tokenOut, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' as const };
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
// Live OBUL-curve state (chain 4663, 2026-10-09).
const state: CurveState = { quoteReserve: 1680047904858931814n, tokenReserve: 999971486016087261842747212n, feeBps: 100n };

beforeEach(() => clearErc20LayoutCache());

describe('makeV3ReverseSolve', () => {
  it('derives the input with ONE quoteExactOutputSingle call', async () => {
    const client = makeFakeClient((req) => {
      const { functionName, args } = decodeFunctionData({ abi: v3QuoterAbi, data: req.data });
      expect(req.to).toBe(V3_QUOTER_ADDRESS);
      expect(functionName).toBe('quoteExactOutputSingle');
      expect(args![0]).toMatchObject({ amount: 1_000_000_000_000n, fee: 10000, sqrtPriceLimitX96: 0n });
      return encodeResult(v3QuoterAbi, 'quoteExactOutputSingle', [143_432_958n, 0n, 1, 86_825n]);
    });
    const solve = makeV3ReverseSolve(client, { tokenIn: launched, tokenOut, fee: 10000 });
    expect(await solve(1_000_000_000_000n, signal)).toBe(143_432_958n);
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it('returns null when the quoter reverts', async () => {
    const solve = makeV3ReverseSolve(makeFakeClient(() => { throw revert(); }), { tokenIn: launched, tokenOut, fee: 10000 });
    expect(await solve(1n, signal)).toBeNull();
  });

  it('propagates a transport error instead of reading it as "no answer"', async () => {
    const solve = makeV3ReverseSolve(makeFakeClient(() => { throw transport(); }), { tokenIn: launched, tokenOut, fee: 10000 });
    await expect(solve(1n, signal)).rejects.toBeInstanceOf(CallExecutionError);
  });

  it('surfaces an invalid address (a programming error) instead of returning null', async () => {
    const client = makeFakeClient(() => encodeResult(v3QuoterAbi, 'quoteExactOutputSingle', [1n, 0n, 1, 1n]));
    const solve = makeV3ReverseSolve(client, { tokenIn: '0xnope' as Address, tokenOut, fee: 10000 });
    await expect(solve(1n, signal)).rejects.toBeInstanceOf(InvalidAddressError);
  });
});

describe('makeV4ReverseSolve', () => {
  it('searches over quoteExactInputSingleV4 and returns an input that covers the target', async () => {
    const client = makeFakeClient((req) => {
      expect(req.to).toBe(V4_QUOTER_ADDRESS);
      const { args } = decodeFunctionData({ abi: v4QuoterAbi, data: req.data });
      const exact = (args![0] as { exactAmount: bigint }).exactAmount;
      return encodeResult(v4QuoterAbi, 'quoteExactInputSingleV4', [exact * 2n, 0n]); // linear 2x
    });
    const solve = makeV4ReverseSolve(client, { poolKey, zeroForOne: true });
    const x = await solve(2_000_000_000_000_000n, signal);
    expect(x).not.toBeNull();
    expect(x! * 2n).toBeGreaterThanOrEqual(2_000_000_000_000_000n);
    expect(x!).toBeLessThanOrEqual((10n ** 15n * 10_001n) / 10_000n + 1n);
  });

  it('returns null when every simulation reverts', async () => {
    const solve = makeV4ReverseSolve(makeFakeClient(() => { throw revert(); }), { poolKey, zeroForOne: true });
    expect(await solve(1000n, signal)).toBeNull();
  });

  it('propagates a transport error from any probe', async () => {
    const solve = makeV4ReverseSolve(makeFakeClient(() => { throw transport(); }), { poolKey, zeroForOne: true });
    await expect(solve(1000n, signal)).rejects.toBeInstanceOf(CallExecutionError);
  });
});

// A fake chain with: the curve (state above), and a USDG-style token (balance@1, allowance@3).
function curveWorld(options: { quoteBalanceBase?: bigint; native?: boolean; stateReadFails?: boolean } = {}) {
  const balanceBase = options.quoteBalanceBase ?? 1n;
  const trades: FakeCallRequest[] = [];
  const client = makeFakeClient((req) => {
    if (req.to.toLowerCase() === curve) {
      const stateCall = (() => { try { return decodeFunctionData({ abi: curveStateAbi, data: req.data }); } catch { return null; } })();
      if (stateCall) {
        if (options.stateReadFails) throw new Error('state read failed');
        const v = stateCall.functionName === 'quoteReserve' ? state.quoteReserve : stateCall.functionName === 'tokenReserve' ? state.tokenReserve : state.feeBps;
        return encodeResult(curveStateAbi, stateCall.functionName, v);
      }
      trades.push(req);
      const { functionName, args } = decodeFunctionData({ abi: curveTradeAbi, data: req.data });
      const amount = args![0] as bigint;
      const diff = req.stateOverride?.flatMap((o) => o.stateDiff ?? []) ?? [];
      const has = (slot: Hex) => diff.some((d) => d.slot.toLowerCase() === slot.toLowerCase() && BigInt(d.value) >= amount);
      if (functionName === 'buy') {
        if (options.native) { if (!(req.value === amount && (req.stateOverride?.[0]?.balance ?? 0n) >= amount)) throw revert('insufficient ETH'); }
        else if (!has(balanceSlotAt(1n)(SIMULATION_ACCOUNT)) || !has(allowanceSlotAt(3n)(SIMULATION_ACCOUNT, curve))) throw revert('InsufficientAllowance');
        if (curveBuyOutput(state, amount) === 0n) throw revert('ZeroOutput');
        return encodeResult(curveTradeAbi, 'buy', curveBuyOutput(state, amount));
      }
      if (!has(balanceSlotAt(0n)(SIMULATION_ACCOUNT)) || !has(allowanceSlotAt(1n)(SIMULATION_ACCOUNT, curve))) throw revert('InsufficientAllowance');
      if (amount > 5n * 10n ** 22n) throw revert('underflow'); // cannot sell more than has been sold
      const out = curveSellOutput(state, amount);
      if (out === 0n) throw revert('ZeroOutput'); // dust sells revert
      return encodeResult(curveTradeAbi, 'sell', out);
    }
    // token contracts: only the discovery probes reach here
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: req.data });
    const isQuote = req.to.toLowerCase() === quoteToken;
    const [bBase, aBase] = isQuote ? [balanceBase, 3n] : [0n, 1n];
    const diff = req.stateOverride?.find((o) => o.address.toLowerCase() === req.to.toLowerCase())?.stateDiff ?? [];
    const read = (slot: Hex) => { const hit = diff.find((d) => d.slot.toLowerCase() === slot.toLowerCase()); return hit ? BigInt(hit.value) : 0n; };
    return functionName === 'balanceOf'
      ? encodeResult(erc20, 'balanceOf', read(balanceSlotAt(bBase)(args![0] as Address)))
      : encodeResult(erc20, 'allowance', read(allowanceSlotAt(aBase)(args![0] as Address, args![1] as Address)));
  });
  return { client, trades };
}

describe('makeCurveReverseSolve', () => {
  it('native-ETH buy: simulates as the synthetic account with value + ETH balance override, no wallet needed', async () => {
    const { client, trades } = curveWorld({ native: true });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: '0x0000000000000000000000000000000000000000', isNativeQuote: true });
    const target = 588905085539402016855496n; // what 1e15 wei buys
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
    expect(Number(x! - 10n ** 15n) / 1e15).toBeLessThan(2e-4);
    expect(trades[0].account).toBe(SIMULATION_ACCOUNT);
  });

  it('ERC20-quoted buy: overrides the quote token balance and allowance (USDG layout) so it works pre-approval', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    const target = 588905085539402016855496n;
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
  });

  it('sell: overrides the launched token balance and allowance (Solmate layout)', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'sell', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    const target = 1663294851n; // what 1e18 tokens sell for
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveSellOutput(state, x!)).toBeGreaterThanOrEqual(target);
    expect(Number(x! - 10n ** 18n) / 1e18).toBeLessThan(2e-4);
  });

  it('a good closed-form guess keeps the number of simulated trades small', async () => {
    const { client, trades } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    await solve(588905085539402016855496n, signal);
    expect(trades.length).toBeLessThanOrEqual(9 + 8 * 4);
  });

  it('returns null without simulating any trade when the spent token\'s slots cannot be discovered', async () => {
    const { client, trades } = curveWorld({ quoteBalanceBase: 500n });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    expect(await solve(588905085539402016855496n, signal)).toBeNull();
    expect(trades).toHaveLength(0);
  });

  it('returns null when the target is more than has been sold (sell over capacity)', async () => {
    const { client } = curveWorld();
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'sell', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    expect(await solve(1_000_000_000_000_000_000n, signal)).toBeNull(); // 1 ETH out of a curve holding 0.0000479
  });

  it('propagates a transport error from a simulated trade instead of reading it as a revert', async () => {
    const { client: world } = curveWorld({ native: true });
    const client = makeFakeClient((req) => {
      if (req.to === curve && req.account === SIMULATION_ACCOUNT) throw new HttpRequestError({ url: 'https://rpc.example', status: 503 });
      return world.call(req);
    });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: '0x0000000000000000000000000000000000000000', isNativeQuote: true });
    await expect(solve(588905085539402016855496n, signal)).rejects.toBeInstanceOf(HttpRequestError);
  });

  it('propagates a transport error from slot discovery (ERC20-quoted buy)', async () => {
    const solve = makeCurveReverseSolve(makeFakeClient(() => { throw transport(); }), { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: quoteToken, isNativeQuote: false });
    await expect(solve(1000n, signal)).rejects.toBeInstanceOf(CallExecutionError);
  });

  it('still works when the curve state cannot be read (no guess, wide search)', async () => {
    const { client } = curveWorld({ native: true, stateReadFails: true });
    const solve = makeCurveReverseSolve(client, { curveAddress: curve, direction: 'buy', tokenAddress: launched, quoteAssetAddress: '0x0000000000000000000000000000000000000000', isNativeQuote: true });
    const target = 588905085539402016855496n;
    const x = await solve(target, signal);
    expect(x).not.toBeNull();
    expect(curveBuyOutput(state, x!)).toBeGreaterThanOrEqual(target);
  });
});
