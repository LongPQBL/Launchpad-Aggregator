import { beforeEach, describe, expect, it } from 'vitest';
import { HttpRequestError, InvalidAddressError, RpcRequestError, decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  MAX_UINT256, SIMULATION_ACCOUNT, allowanceSlotAt, balanceSlotAt, clearErc20LayoutCache,
  discoverErc20Layouts, nativeBalanceOverride, spendStateOverride,
} from './erc20-state-override';
import { encodeResult, makeFakeClient, type FakeCallRequest } from './test-support/fake-call-client';

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const token = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;

// A fake token whose storage lives at the given mapping bases (balance@b, allowance@a).
function fakeToken(balanceBase: bigint, allowanceBase: bigint) {
  return makeFakeClient((req: FakeCallRequest) => {
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: req.data });
    const diff = req.stateOverride?.find((o) => o.address.toLowerCase() === token)?.stateDiff ?? [];
    const read = (slot: Hex): bigint => {
      const hit = diff.find((d) => d.slot.toLowerCase() === slot.toLowerCase());
      return hit ? BigInt(hit.value) : 0n;
    };
    if (functionName === 'balanceOf') return encodeResult(erc20, 'balanceOf', read(balanceSlotAt(balanceBase)(args![0] as Address)));
    return encodeResult(erc20, 'allowance', read(allowanceSlotAt(allowanceBase)(args![0] as Address, args![1] as Address)));
  });
}

beforeEach(() => clearErc20LayoutCache());

describe('discoverErc20Layouts', () => {
  it('finds a USDG-style layout (balance@1, allowance@3)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(1n, 3n), token);
    expect(layouts.balanceSlot).not.toBeNull();
    expect(layouts.allowanceSlot).not.toBeNull();
    const owner = SIMULATION_ACCOUNT;
    expect(layouts.balanceSlot!(owner)).toBe(balanceSlotAt(1n)(owner));
    expect(layouts.allowanceSlot!(owner, token)).toBe(allowanceSlotAt(3n)(owner, token));
  });

  it('finds a Solmate-style layout (balance@0, allowance@1)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(0n, 1n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(0n)(SIMULATION_ACCOUNT));
    expect(layouts.allowanceSlot!(SIMULATION_ACCOUNT, token)).toBe(allowanceSlotAt(1n)(SIMULATION_ACCOUNT, token));
  });

  it('finds an OpenZeppelin-5 namespaced layout', async () => {
    const ns = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00');
    const layouts = await discoverErc20Layouts(fakeToken(ns, ns + 1n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(ns)(SIMULATION_ACCOUNT));
    expect(layouts.allowanceSlot!(SIMULATION_ACCOUNT, token)).toBe(allowanceSlotAt(ns + 1n)(SIMULATION_ACCOUNT, token));
  });

  it('finds a layout that only the second probing stage covers (base 7)', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(7n, 8n), token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(7n)(SIMULATION_ACCOUNT));
  });

  it('reports null slots for an unsupported layout instead of guessing', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(500n, 501n), token);
    expect(layouts).toEqual({ balanceSlot: null, allowanceSlot: null });
  });

  it('treats a reverted probe as "not found"', async () => {
    const client = makeFakeClient(() => {
      throw new RpcRequestError({ body: {}, url: 'https://rpc.example', error: { code: 3, message: 'execution reverted' } });
    });
    expect(await discoverErc20Layouts(client, token)).toEqual({ balanceSlot: null, allowanceSlot: null });
  });

  it('does not cache a transport failure: a later call retries and discovers the slots', async () => {
    const healthy = fakeToken(1n, 3n);
    let failed = false;
    const client = makeFakeClient((req: FakeCallRequest) => {
      if (!failed) { failed = true; throw new HttpRequestError({ url: 'https://rpc.example', status: 503 }); }
      return healthy.call(req);
    });
    await expect(discoverErc20Layouts(client, token)).rejects.toBeInstanceOf(HttpRequestError);
    const layouts = await discoverErc20Layouts(client, token);
    expect(layouts.balanceSlot!(SIMULATION_ACCOUNT)).toBe(balanceSlotAt(1n)(SIMULATION_ACCOUNT));
    expect(layouts.allowanceSlot!(SIMULATION_ACCOUNT, token)).toBe(allowanceSlotAt(3n)(SIMULATION_ACCOUNT, token));
  });

  it('rethrows a programming error instead of reading it as "slot not found"', async () => {
    const client = makeFakeClient(() => { throw new InvalidAddressError({ address: '0xnope' }); });
    await expect(discoverErc20Layouts(client, token)).rejects.toBeInstanceOf(InvalidAddressError);
  });

  it('still caches a genuinely unsupported layout as null (no second round of calls)', async () => {
    const client = fakeToken(500n, 501n);
    expect(await discoverErc20Layouts(client, token)).toEqual({ balanceSlot: null, allowanceSlot: null });
    const calls = client.call.mock.calls.length;
    expect(await discoverErc20Layouts(client, token)).toEqual({ balanceSlot: null, allowanceSlot: null });
    expect(client.call.mock.calls.length).toBe(calls);
  });

  it('caches per token: a second call makes no more RPC calls', async () => {
    const client = fakeToken(1n, 3n);
    await discoverErc20Layouts(client, token);
    const calls = client.call.mock.calls.length;
    await discoverErc20Layouts(client, token.toUpperCase().replace('0X', '0x') as Address);
    expect(client.call.mock.calls.length).toBe(calls);
  });
});

describe('spendStateOverride', () => {
  it('sets the owner balance and the owner→spender allowance to max on the token', async () => {
    const layouts = await discoverErc20Layouts(fakeToken(1n, 3n), token);
    const spender = '0x4444444444444444444444444444444444444444' as Address;
    const override = spendStateOverride({ layouts, token, owner: SIMULATION_ACCOUNT, spender });
    expect(override).toHaveLength(1);
    expect(override![0].address).toBe(token);
    const slots = override![0].stateDiff!.map((d) => d.slot);
    expect(slots).toContain(balanceSlotAt(1n)(SIMULATION_ACCOUNT));
    expect(slots).toContain(allowanceSlotAt(3n)(SIMULATION_ACCOUNT, spender));
    for (const d of override![0].stateDiff!) expect(BigInt(d.value)).toBe(MAX_UINT256);
  });

  it('returns null when either slot is unknown', () => {
    expect(spendStateOverride({ layouts: { balanceSlot: null, allowanceSlot: null }, token, owner: SIMULATION_ACCOUNT, spender: token })).toBeNull();
    expect(spendStateOverride({ layouts: { balanceSlot: balanceSlotAt(1n), allowanceSlot: null }, token, owner: SIMULATION_ACCOUNT, spender: token })).toBeNull();
  });
});

describe('nativeBalanceOverride', () => {
  it('gives the owner a large native balance', () => {
    const override = nativeBalanceOverride(SIMULATION_ACCOUNT);
    expect(override).toEqual([{ address: SIMULATION_ACCOUNT, balance: 10n ** 30n }]);
  });
});
