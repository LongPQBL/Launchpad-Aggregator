import { parseAbi, type Address } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';
import { readLensSnapshot, type LensPoolKey } from './lens.js';

const v2Abi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)']);
const v3Abi = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface PoolAmountsRow extends LensPoolKey { protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string }
export interface PoolAmounts { blockNumber: bigint; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }

/** Floor square root of a non-negative integer (Newton's method). */
export function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('integerSqrt of a negative number');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}

function isAmount(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n; }

/**
 * Both sides' amounts of a pool and its spot price (sqrt, Q64.96) at `atBlock` (default: the current block; an old block needs an archive RPC): the V4 reserves lens, a V3 pool's token
 * balances plus `slot0` (uncollected fees included), or a V2 pair's reserves with the price they imply.
 * Null when anything cannot be read or the pool is empty — never a guess.
 */
export async function readPoolAmounts(client: UsdPriceClient, row: PoolAmountsRow, atBlock?: bigint): Promise<PoolAmounts | null> {
  if (row.protocol === 'uniswap_v4') {
    const lens = await readLensSnapshot(client, row, atBlock);
    return lens ? { blockNumber: lens.blockNumber, amount0: lens.coreAmount0, amount1: lens.coreAmount1, sqrtPriceX96: lens.sqrtPriceX96 } : null;
  }
  if (atBlock === undefined && !client.getBlockNumber) return null;
  try {
    const blockNumber = atBlock ?? await client.getBlockNumber!();
    const pool = row.poolId as Address;
    if (row.protocol === 'uniswap_v2') {
      const reserves = await client.readContract({ address: pool, abi: v2Abi, functionName: 'getReserves', blockNumber });
      if (!Array.isArray(reserves) || !isAmount(reserves[0]) || !isAmount(reserves[1]) || reserves[0] === 0n || reserves[1] === 0n) return null;
      const sqrtPriceX96 = integerSqrt((reserves[1] << 192n) / reserves[0]);
      return sqrtPriceX96 > 0n ? { blockNumber, amount0: reserves[0], amount1: reserves[1], sqrtPriceX96 } : null;
    }
    const [slot0, amount0, amount1] = await Promise.all([
      client.readContract({ address: pool, abi: v3Abi, functionName: 'slot0', blockNumber }),
      client.readContract({ address: row.currency0 as Address, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber }),
      client.readContract({ address: row.currency1 as Address, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber }),
    ]);
    if (!Array.isArray(slot0) || typeof slot0[0] !== 'bigint' || slot0[0] <= 0n || !isAmount(amount0) || !isAmount(amount1)) return null;
    return { blockNumber, amount0, amount1, sqrtPriceX96: slot0[0] };
  } catch { return null; }
}
