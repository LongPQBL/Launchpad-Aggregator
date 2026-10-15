import { describe, expect, it } from 'vitest';
import { buildCurveDepth, readCurveDepthAnswer } from './curveDepth.js';

const e18 = 10n ** 18n;
// 4 quote and 1,000,000 tokens of virtual reserves: price 0.000004 quote per token; 1% fee; graduates at 10 quote of real reserve (2 already in).
const state = { quoteReserve: 4n * e18, tokenReserve: 1_000_000n * e18, feeBps: 100n, realQuoteReserve: 2n * e18, graduationThreshold: 10n * e18 };
const decimals = { quote: 18, token: 18 };

describe('buildCurveDepth', () => {
  it('starts at the current price and moves 1% per row', () => {
    const depth = buildCurveDepth(state, decimals, 3);
    expect(depth.asks[0]!.price).toBeCloseTo(0.000004 * 1.01, 12);
    expect(depth.asks[1]!.price).toBeCloseTo(0.000004 * 1.01 ** 2, 12);
    expect(depth.bids[0]!.price).toBeCloseTo(0.000004 / 1.01, 12);
  });
  it('costs what the constant-product formula says for the first ask row, grossed up by the fee', () => {
    const depth = buildCurveDepth(state, decimals, 1);
    const q = 4; const t = 1_000_000; const k = q * t;
    const q1 = q * Math.sqrt(1.01);
    const net = q1 - q;
    expect(depth.asks[0]!.total1).toBeCloseTo(net / 0.99, 9);
    expect(depth.asks[0]!.amount0).toBeCloseTo(t - k / q1, 6);
  });
  it('pays out less than the gross on bids (the fee comes off the quote received)', () => {
    const depth = buildCurveDepth(state, decimals, 1);
    const q1 = 4 / Math.sqrt(1.01);
    expect(depth.bids[0]!.total1).toBeCloseTo((4 - q1) * 0.99, 9);
  });
  it('ends the asks at the graduation threshold and the bids at the real reserve', () => {
    const depth = buildCurveDepth(state, decimals, 400);
    expect(depth.asksEndAtGraduation).toBe(true);
    expect(depth.bidsEndAtEmptyReserve).toBe(true);
    // net quote that can still be added is 10 - 2 = 8; the last ask row's cumulative cost is that, grossed up by the fee
    expect(depth.asks.at(-1)!.cumulative1).toBeCloseTo(8 / 0.99, 6);
    // bids can pay out at most the 2 of real reserve, less the fee
    expect(depth.bids.at(-1)!.cumulative1).toBeCloseTo(2 * 0.99, 6);
  });
  it('has no asks once the curve is at the threshold and no bids with an empty real reserve; spread is twice the fee', () => {
    expect(buildCurveDepth({ ...state, realQuoteReserve: 10n * e18 }, decimals).asks).toEqual([]);
    expect(buildCurveDepth({ ...state, realQuoteReserve: 0n }, decimals).bids).toEqual([]);
    expect(buildCurveDepth(state, decimals).spreadPercent).toBeCloseTo(2, 12);
  });
  it('shows no rows for dust: a curve nobody has traded on has nothing to sell into', () => {
    const dust = buildCurveDepth({ ...state, realQuoteReserve: 17n }, decimals);
    expect(dust.bids).toEqual([]);
    expect(dust.asks.length).toBeGreaterThan(0);
  });
  it('adjusts prices for differing decimals', () => {
    const six = buildCurveDepth({ ...state, quoteReserve: 4_000_000n }, { quote: 6, token: 18 }, 1);
    expect(six.asks[0]!.price).toBeCloseTo(0.000004 * 1.01, 10);
  });
});

describe('readCurveDepthAnswer: what the curve really holds', () => {
  const token = `0x${'a1'.repeat(20)}`;
  const curve = `0x${'c2'.repeat(20)}`;
  const pool = { query: async () => ({ rows: [{ curve, factory_address: `0x${'f3'.repeat(20)}`, token_decimals: 18, quote_asset_decimals: 18 }] }) } as never;
  // A curve with a VIRTUAL quote reserve: quoteReserve is 6 but only 2 was ever paid in (realQuoteReserve); the token side is held for real.
  const clientWith = (balance: bigint | 'fails') => ({
    getBlockNumber: async () => 100n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'quoteReserve') return 6n * e18;
      if (functionName === 'tokenReserve') return 1_000_000n * e18;
      if (functionName === 'feeBps') return 100n;
      if (functionName === 'realQuoteReserve') return 2n * e18;
      if (functionName === 'getLaunchedToken') return { phase: 0, graduationThreshold: 10n * e18, creatorTaxBps: 0, exists: true };
      if (functionName === 'balanceOf') { if (balance === 'fails') throw new Error('revert'); return balance; }
      throw new Error(functionName);
    },
  }) as never;

  it('reports the token balance of the curve and the real (not virtual) quote reserve, next to the virtual reserves the price comes from', async () => {
    const answer = await readCurveDepthAnswer(pool, clientWith(900_000n * e18), { chainId: 4663, tokenAddress: token });
    expect(answer).toMatchObject({ complete: true, tokenBalance: (900_000n * e18).toString(), realQuoteReserve: (2n * e18).toString(), quoteReserve: (6n * e18).toString() });
    // The quote side that is held is the 2 paid in, never the 6 of the virtual reserve.
    expect(answer!.realQuoteReserve).not.toBe(answer!.quoteReserve);
  });
  it('leaves the token balance unknown when it cannot be read, without failing the depth', async () => {
    const answer = await readCurveDepthAnswer(pool, clientWith('fails'), { chainId: 4663, tokenAddress: token });
    expect(answer).toMatchObject({ complete: true, tokenBalance: null });
  });
});
