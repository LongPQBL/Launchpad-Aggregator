import { describe, expect, it } from 'vitest';
import { numberToHex } from 'viem';
import { readPoolLiquidity, v4BitmapSlot, v4StateSlot, v4TickSlot, type LiquidityClient } from './liquidityRead.js';

const poolId = '0x1049aa4bdc1841d7eba9861d40aed69cb679272ace4a5cea9a8cfcbd84d9d651';
const pad = (value: bigint) => numberToHex(BigInt.asUintN(256, value), { size: 32 });

function v3Client(initialized: Record<number, bigint>, spacing: number, failOn?: string): LiquidityClient {
  return {
    async getBlockNumber() { return 500n; },
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      if (functionName === failOn) throw new Error('rpc down');
      if (functionName === 'slot0') return [2n ** 96n, -5, 0, 0, 0, 0, true];
      if (functionName === 'liquidity') return 7n;
      if (functionName === 'tickBitmap') {
        const word = Number(args![0]);
        let bitmap = 0n;
        for (const tick of Object.keys(initialized).map(Number)) {
          const compressed = tick / spacing;
          if (Math.floor(compressed / 256) === word) bitmap |= 1n << BigInt(((compressed % 256) + 256) % 256);
        }
        return bitmap;
      }
      if (functionName === 'ticks') return [0n, initialized[Number(args![0])], 0n, 0n, 0n, 0n, 0, true];
      throw new Error(functionName);
    },
  } as unknown as LiquidityClient;
}

describe('readPoolLiquidity V3', () => {
  it('reads the tick, price, liquidity and every initialized tick\'s net liquidity at one block', async () => {
    const result = await readPoolLiquidity(v3Client({ [-200]: 7n, 400: -7n }, 200), { protocol: 'uniswap_v3', poolId: '0x2fc8347baa2512ede02b225726fdb739190f80a9', tickSpacing: 200 });
    expect(result).toEqual({ ok: true, blockNumber: 500n, tick: -5, sqrtPriceX96: 2n ** 96n, liquidity: 7n,
      ticks: [{ tick: -200, liquidityNet: 7n }, { tick: 400, liquidityNet: -7n }] });
  });
  it('answers read_failed when any read fails, instead of a partial tick set', async () => {
    expect(await readPoolLiquidity(v3Client({ [-200]: 7n }, 200, 'ticks'), { protocol: 'uniswap_v3', poolId: '0x2fc8347baa2512ede02b225726fdb739190f80a9', tickSpacing: 200 })).toEqual({ ok: false, reason: 'read_failed' });
  });
  it('refuses a tick spacing that would need too many words', async () => {
    expect(await readPoolLiquidity(v3Client({}, 1), { protocol: 'uniswap_v3', poolId: '0x2fc8347baa2512ede02b225726fdb739190f80a9', tickSpacing: 1 }, { maxWords: 100 })).toEqual({ ok: false, reason: 'too_many_ticks' });
  });
  it('treats a pool without initialized ticks as an empty tick set', async () => {
    const result = await readPoolLiquidity(v3Client({}, 200), { protocol: 'uniswap_v3', poolId: '0x2fc8347baa2512ede02b225726fdb739190f80a9', tickSpacing: 200 });
    expect(result).toMatchObject({ ok: true, ticks: [] });
  });
});

describe('readPoolLiquidity V4', () => {
  it('reads state from PoolManager storage using the StateLibrary slot layout', async () => {
    const stateSlot = v4StateSlot(poolId);
    const spacing = 60;
    const tickSlot = v4TickSlot(stateSlot, -120);
    const compressed = -120 / spacing; // -2 -> word -1, bit 254
    const bitmapSlot = v4BitmapSlot(stateSlot, -1);
    const slot0 = (2n ** 96n) | (BigInt.asUintN(24, -3n) << 160n);
    const storage = new Map<string, bigint>([
      [pad(stateSlot), slot0], [pad(stateSlot + 3n), 9n],
      [pad(bitmapSlot), 1n << BigInt(((compressed % 256) + 256) % 256)],
      [pad(tickSlot), (BigInt.asUintN(128, 9n) << 128n) | 9n], // net +9 in the high half, gross 9 in the low half
    ]);
    const client = { async getBlockNumber() { return 77n; }, async readContract({ args }: { args?: readonly unknown[] }) { return pad(storage.get(String(args![0])) ?? 0n); } } as unknown as LiquidityClient;
    const result = await readPoolLiquidity(client, { protocol: 'uniswap_v4', poolId, tickSpacing: spacing });
    expect(result).toEqual({ ok: true, blockNumber: 77n, tick: -3, sqrtPriceX96: 2n ** 96n, liquidity: 9n, ticks: [{ tick: -120, liquidityNet: 9n }] });
  });
  it('answers read_failed for an uninitialized pool (zero sqrt price)', async () => {
    const client = { async getBlockNumber() { return 1n; }, async readContract() { return pad(0n); } } as unknown as LiquidityClient;
    expect(await readPoolLiquidity(client, { protocol: 'uniswap_v4', poolId, tickSpacing: 60 })).toEqual({ ok: false, reason: 'read_failed' });
  });
});
