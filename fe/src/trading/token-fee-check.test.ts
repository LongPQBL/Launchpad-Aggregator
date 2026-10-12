import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { buildFeeProbe, checkTokenFee, feeWarning, interpretFeeProbe, type SimulateClient } from './token-fee-check';

const token = '0x00000000000000000000000000000000000000aa' as Address;
const holder = '0x00000000000000000000000000000000000000bb' as Address;
const uint = (value: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [value]);
const ok = (returnData: Hex = '0x') => ({ status: '0x1', returnData });
const failed = { status: '0x0', returnData: '0x' as Hex };
const AMOUNT = 1_000_000n;

// Result layout from buildFeeProbe: 0 buy, 1 wallet balance, 2 transfer, 3 receiver balance, 4 holder before, 5 sell, 6 holder after.
const legs = (received: { buy?: bigint; transfer?: bigint; sell?: bigint }) => [
  ok(), ok(uint(received.buy ?? AMOUNT)),
  ok(), ok(uint(received.transfer ?? AMOUNT / 4n)),
  ok(uint(10n * AMOUNT)), ok(), ok(uint(10n * AMOUNT + (received.sell ?? AMOUNT / 4n))),
];

describe('buildFeeProbe', () => {
  it('starts every leg from the holder, so no token storage layout has to be known', () => {
    const calls = buildFeeProbe(token, holder);
    expect(calls).toHaveLength(7);
    expect(calls[0].from).toBe(holder); // the buy: the pool sends the token out
    expect(calls[2].from).toBe(calls[5].from); // both follow-up legs spend from the wallet that the buy funded
    expect(calls[2].from).not.toBe(holder);
  });
});

describe('interpretFeeProbe', () => {
  it('reports no fee for a token that delivers everything', () => {
    expect(interpretFeeProbe(legs({}))).toEqual({ status: 'checked', transferFeeBps: 0, buyFeeBps: 0, sellFeeBps: 0, reverted: [] });
  });
  it('turns a shortfall into basis points, per leg', () => {
    const check = interpretFeeProbe(legs({ buy: 950_000n, transfer: 247_500n, sell: 225_000n }));
    expect(check).toMatchObject({ buyFeeBps: 500, transferFeeBps: 100, sellFeeBps: 1000 });
  });
  it('records a leg that reverted and measures nothing for it, never a made-up zero', () => {
    const base = legs({});
    expect(interpretFeeProbe([base[0], base[1], base[2], base[3], base[4], failed, base[6]])).toMatchObject({ sellFeeBps: null, reverted: ['sell'] });
    expect(interpretFeeProbe([failed, ...base.slice(1)])).toMatchObject({ buyFeeBps: null, reverted: ['buy'] });
  });
  it('blames only the buy leg when its fee is too large to fund the later legs', () => {
    const base = legs({ buy: 300_000n });
    const check = interpretFeeProbe([base[0], base[1], failed, base[3], base[4], failed, base[6]]);
    expect(check).toMatchObject({ buyFeeBps: 7000, transferFeeBps: null, sellFeeBps: null, reverted: [] });
  });
});

describe('feeWarning', () => {
  it('says nothing for a clean token and for rounding-sized differences', () => {
    expect(feeWarning({ status: 'checked', transferFeeBps: 0, buyFeeBps: 0, sellFeeBps: 0, reverted: [] }, 'AAA')).toBeNull();
    expect(feeWarning({ status: 'checked', transferFeeBps: 1, buyFeeBps: null, sellFeeBps: 3, reverted: [] }, 'AAA')).toBeNull();
    expect(feeWarning({ status: 'unchecked', reason: 'x' }, 'AAA')).toBeNull();
  });
  it('names the token, the legs and the percentage', () => {
    const text = feeWarning({ status: 'checked', transferFeeBps: null, buyFeeBps: 500, sellFeeBps: 1250, reverted: [] }, 'AAA');
    expect(text).toContain('AAA charges a fee on buy (5%), sell (12.50%)');
    expect(text).toContain('less than the quote');
  });
  it('warns when a transfer is refused', () => {
    expect(feeWarning({ status: 'checked', transferFeeBps: 0, buyFeeBps: 0, sellFeeBps: null, reverted: ['sell'] }, 'AAA')).toContain('refused a simulated sell transfer');
  });
});

describe('checkTokenFee', () => {
  const client = (simulate: () => unknown): SimulateClient => ({ request: vi.fn(async () => simulate()), call: vi.fn() } as unknown as SimulateClient);

  it('reads the simulated balances through one eth_simulateV1 request', async () => {
    const c = client(() => [{ calls: legs({ sell: 225_000n }) }]);
    const check = await checkTokenFee(c, token, holder);
    expect(check).toMatchObject({ status: 'checked', sellFeeBps: 1000 });
    expect((c.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((c.request as ReturnType<typeof vi.fn>).mock.calls[0][0].method).toBe('eth_simulateV1');
  });
  it('is unchecked, never "no fee", when the simulation fails or answers oddly', async () => {
    expect(await checkTokenFee(client(() => { throw new Error('method not found'); }), token, holder)).toMatchObject({ status: 'unchecked' });
    expect(await checkTokenFee(client(() => [{ calls: [] }]), token, holder)).toMatchObject({ status: 'unchecked' });
  });
});
