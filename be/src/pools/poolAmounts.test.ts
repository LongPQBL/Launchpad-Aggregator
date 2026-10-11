import { describe, expect, it } from 'vitest';
import { integerSqrt, readPoolAmounts } from './poolAmounts.js';

const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const pair = '0x3333333333333333333333333333333333333333';
const row = (protocol: 'uniswap_v2' | 'uniswap_v3') => ({ protocol, poolId: pair, currency0: a, currency1: b, fee: 3000, tick_spacing: 60, hooks: '0x0000000000000000000000000000000000000000' });

describe('integerSqrt', () => {
  it('returns the floor of the square root', () => {
    expect(integerSqrt(0n)).toBe(0n);
    expect(integerSqrt(15n)).toBe(3n);
    expect(integerSqrt(16n)).toBe(4n);
    expect(integerSqrt(2n ** 192n)).toBe(2n ** 96n);
  });
});

describe('readPoolAmounts', () => {
  it('reads a V2 pair: reserves and a sqrt price derived from them', async () => {
    const client = {
      getBlockNumber: async () => 77n,
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'getReserves') return [2n * 10n ** 18n, 8n * 10n ** 18n, 5];
        throw new Error(functionName);
      },
    };
    const result = await readPoolAmounts(client, row('uniswap_v2'));
    expect(result).toEqual({ blockNumber: 77n, amount0: 2n * 10n ** 18n, amount1: 8n * 10n ** 18n, sqrtPriceX96: 2n * 2n ** 96n });
  });
  it('returns null for an empty V2 pair instead of a made-up price', async () => {
    const client = { getBlockNumber: async () => 1n, readContract: async () => [0n, 0n, 0] };
    expect(await readPoolAmounts(client, row('uniswap_v2'))).toBeNull();
  });
  it('reads a V3 pool: token balances held by the pool plus slot0 price', async () => {
    const client = {
      getBlockNumber: async () => 90n,
      async readContract({ functionName, address }: { functionName: string; address: string }) {
        if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true];
        if (functionName === 'balanceOf') return address === a ? 5n : 7n;
        throw new Error(functionName);
      },
    };
    expect(await readPoolAmounts(client, row('uniswap_v3'))).toEqual({ blockNumber: 90n, amount0: 5n, amount1: 7n, sqrtPriceX96: 2n ** 96n });
  });
  it('returns null when a read fails', async () => {
    const client = { getBlockNumber: async () => 1n, readContract: async () => { throw new Error('rpc down'); } };
    expect(await readPoolAmounts(client, row('uniswap_v3'))).toBeNull();
  });
});
