import { encodeAbiParameters, hexToBigInt, keccak256, numberToHex, parseAbi, type Address, type Hex } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
// More words than this means a very fine tick spacing; the read stops instead of returning a partial tick set.
export const DEFAULT_MAX_WORDS = 400;
const CONCURRENCY = 16;

const v3Abi = parseAbi([
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
]);
const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

export type LiquidityClient = UsdPriceClient & { getBlockNumber(): Promise<bigint> };
export interface LiquidityPool { protocol: 'uniswap_v3' | 'uniswap_v4'; poolId: string; tickSpacing: number }
export interface TickLiquidity { tick: number; liquidityNet: bigint }
export type PoolLiquidityRead =
  | { ok: true; blockNumber: bigint; tick: number; sqrtPriceX96: bigint; liquidity: bigint; ticks: TickLiquidity[] }
  | { ok: false; reason: 'read_failed' | 'too_many_ticks' };

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!);
  }));
  return results;
}

const signed = (value: bigint, bits: number): number => Number(BigInt.asIntN(bits, value));

/** Storage slot of a V4 pool's state struct (`StateLibrary._getPoolStateSlot`): keccak256(poolId, POOLS_SLOT = 6). */
export function v4StateSlot(poolId: string): bigint {
  return hexToBigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId as Hex, 6n])));
}
/** Slot of `tickBitmap[word]` (mapping at state slot + 5) and of `ticks[tick]` (mapping at state slot + 4). */
export function v4BitmapSlot(stateSlot: bigint, word: number): bigint {
  return hexToBigInt(keccak256(encodeAbiParameters([{ type: 'int16' }, { type: 'bytes32' }], [word, numberToHex(stateSlot + 5n, { size: 32 })])));
}
export function v4TickSlot(stateSlot: bigint, tick: number): bigint {
  return hexToBigInt(keccak256(encodeAbiParameters([{ type: 'int24' }, { type: 'bytes32' }], [tick, numberToHex(stateSlot + 4n, { size: 32 })])));
}

function wordRange(tickSpacing: number): { minWord: number; maxWord: number } {
  return { minWord: Math.floor(Math.floor(MIN_TICK / tickSpacing) / 256), maxWord: Math.floor(Math.floor(MAX_TICK / tickSpacing) / 256) };
}

function initializedTicks(words: readonly number[], bitmaps: readonly bigint[], tickSpacing: number): number[] {
  const ticks: number[] = [];
  bitmaps.forEach((bitmap, index) => {
    if (bitmap === 0n) return;
    for (let bit = 0; bit < 256; bit += 1) if ((bitmap >> BigInt(bit)) & 1n) ticks.push((words[index]! * 256 + bit) * tickSpacing);
  });
  return ticks;
}

/**
 * Current tick, sqrt price, active liquidity and the net liquidity at every initialized tick of a V3 or V4 pool, all read at one block.
 * Any failed read, or a tick set too large to read in full, is an `ok: false` answer — never a partial tick set.
 */
export async function readPoolLiquidity(client: LiquidityClient, pool: LiquidityPool, options: { maxWords?: number } = {}): Promise<PoolLiquidityRead> {
  const { minWord, maxWord } = wordRange(pool.tickSpacing);
  if (maxWord - minWord + 1 > (options.maxWords ?? DEFAULT_MAX_WORDS)) return { ok: false, reason: 'too_many_ticks' };
  const words = Array.from({ length: maxWord - minWord + 1 }, (_, index) => minWord + index);
  try {
    const blockNumber = await client.getBlockNumber();
    if (pool.protocol === 'uniswap_v3') {
      const address = pool.poolId as Address;
      const [slot0, liquidity] = await Promise.all([
        client.readContract({ address, abi: v3Abi, functionName: 'slot0', blockNumber }),
        client.readContract({ address, abi: v3Abi, functionName: 'liquidity', blockNumber }),
      ]);
      if (!Array.isArray(slot0) || typeof slot0[0] !== 'bigint' || typeof liquidity !== 'bigint') return { ok: false, reason: 'read_failed' };
      const bitmaps = await mapLimit(words, CONCURRENCY, (word) => client.readContract({ address, abi: v3Abi, functionName: 'tickBitmap', args: [word], blockNumber }) as Promise<bigint>);
      const ticks = await mapLimit(initializedTicks(words, bitmaps, pool.tickSpacing), CONCURRENCY, async (tick) => {
        const info = await client.readContract({ address, abi: v3Abi, functionName: 'ticks', args: [tick], blockNumber });
        if (!Array.isArray(info) || typeof info[1] !== 'bigint') throw new Error('bad tick info');
        return { tick, liquidityNet: info[1] };
      });
      return { ok: true, blockNumber, tick: Number(slot0[1]), sqrtPriceX96: slot0[0], liquidity, ticks };
    }
    const stateSlot = v4StateSlot(pool.poolId);
    const read = async (slot: bigint): Promise<bigint> => hexToBigInt(await client.readContract({ address: POOL_MANAGER, abi: managerAbi, functionName: 'extsload', args: [numberToHex(slot, { size: 32 })], blockNumber }) as Hex);
    const [slot0, liquidityWord] = await Promise.all([read(stateSlot), read(stateSlot + 3n)]);
    const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
    if (sqrtPriceX96 === 0n) return { ok: false, reason: 'read_failed' }; // an uninitialized pool
    const bitmaps = await mapLimit(words, CONCURRENCY, (word) => read(v4BitmapSlot(stateSlot, word)));
    const ticks = await mapLimit(initializedTicks(words, bitmaps, pool.tickSpacing), CONCURRENCY, async (tick) => {
      const first = await read(v4TickSlot(stateSlot, tick));
      return { tick, liquidityNet: BigInt.asIntN(128, first >> 128n) };
    });
    return { ok: true, blockNumber, tick: signed((slot0 >> 160n) & 0xffffffn, 24), sqrtPriceX96, liquidity: liquidityWord & ((1n << 128n) - 1n), ticks };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}
