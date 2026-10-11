import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAssetDecimalsCacheForTests, assetDecimals } from './stats.js';

const token = '0x7777777777777777777777777777777777777777';
beforeEach(() => __resetAssetDecimalsCacheForTests());

describe('assetDecimals', () => {
  it('reads a token\'s decimals once and remembers them', async () => {
    const readContract = vi.fn(async () => 6);
    const client = { readContract } as never;
    expect(await assetDecimals(client, token)).toBe(6);
    expect(await assetDecimals(client, token.toUpperCase().replace('0X', '0x'))).toBe(6);
    expect(readContract).toHaveBeenCalledTimes(1);
  });
  it('keeps chains apart and does not remember a failed or invalid read', async () => {
    const onChain = (id: number, value: unknown) => ({ chain: { id }, readContract: vi.fn(async () => value) }) as never;
    expect(await assetDecimals(onChain(1, 6), token)).toBe(6);
    expect(await assetDecimals(onChain(2, 8), token)).toBe(8);
    const failing = { readContract: vi.fn(async () => { throw new Error('rpc down'); }) } as never;
    expect(await assetDecimals(failing, token)).toBeNull();
    const recovered = { readContract: vi.fn(async () => 18) } as never;
    expect(await assetDecimals(recovered, token)).toBe(18);
    expect(await assetDecimals({ readContract: async () => 99 } as never, '0x8888888888888888888888888888888888888888')).toBeNull();
  });
  it('answers 18 for the native asset and null without a client', async () => {
    expect(await assetDecimals(undefined, '0x0000000000000000000000000000000000000000')).toBe(18);
    expect(await assetDecimals(undefined, token)).toBeNull();
  });
});
