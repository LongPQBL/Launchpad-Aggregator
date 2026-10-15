import { parseAbi, type Address } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const RESERVES_LENS = '0x0000001b173C3bbF3984D417d8614E3eed34865B' as Address;
const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct PoolTVL { uint256 coreAmount0; uint256 coreAmount1; uint256 hookReserves0; uint256 hookReserves1; uint256 hookEffective0; uint256 hookEffective1; uint160 sqrtPriceX96; int24 tick; uint128 activeLiquidity; uint256 blockNumber; address statsProvider; uint16 hookPermissions; bool hasCustomAccounting; uint8 statsStatus; }',
  'function getPoolTVL(address manager, PoolKey key) view returns (PoolTVL result)',
]);

// Uniswap V4 hook permission flags that let a hook change what the pool's liquidity holds: beforeSwap, afterAddLiquidity and afterRemoveLiquidity may
// return a delta (a custom curve, liquidity kept in the hook). afterSwap may return a delta too, but that only moves the hook's own fee out of a swap
// and leaves the pool's liquidity positions on the standard curve.
const BEFORE_SWAP_RETURNS_DELTA = 1 << 3;
const AFTER_ADD_LIQUIDITY_RETURNS_DELTA = 1 << 1;
const AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA = 1 << 0;
const LIQUIDITY_CHANGING_FLAGS = BEFORE_SWAP_RETURNS_DELTA | AFTER_ADD_LIQUIDITY_RETURNS_DELTA | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA;

/**
 * The lens flags every hook that returns a delta as "custom accounting" and answers it with the hook's own reserves. The pool's core reserves still
 * describe it when the hook holds nothing of its own (all four hook figures are zero) and its only delta-returning permission is afterSwap (a fee
 * taken out of swaps, as the Pons hook does); any other case is left unanswered, never read as if it were standard.
 */
function hasStandardAccounting(result: object): boolean {
  const value = result as { hasCustomAccounting?: unknown; hookPermissions?: unknown; hookReserves0?: unknown; hookReserves1?: unknown; hookEffective0?: unknown; hookEffective1?: unknown };
  if (value.hasCustomAccounting === false) return true;
  if (value.hasCustomAccounting !== true || typeof value.hookPermissions !== 'number') return false;
  const noOwnFunds = [value.hookReserves0, value.hookReserves1, value.hookEffective0, value.hookEffective1].every((figure) => figure === 0n);
  return noOwnFunds && (value.hookPermissions & LIQUIDITY_CHANGING_FLAGS) === 0;
}

export interface LensPoolKey { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }
export interface LensSnapshot { blockNumber: bigint; coreAmount0: bigint; coreAmount1: bigint; sqrtPriceX96: bigint }

/** Core reserves + spot price of a V4 pool from the reserves lens at `atBlock` (default: the current block); null if unavailable or invalid. */
export async function readLensSnapshot(client: UsdPriceClient | undefined, catalog: LensPoolKey, atBlock?: bigint): Promise<LensSnapshot | null> {
  if (!client || (atBlock === undefined && !client.getBlockNumber)) return null;
  try {
    const blockNumber = atBlock ?? await client.getBlockNumber!();
    const result = await client.readContract({ address: RESERVES_LENS, abi: lensAbi, functionName: 'getPoolTVL',
      args: [POOL_MANAGER, { currency0: catalog.currency0 as Address, currency1: catalog.currency1 as Address,
        fee: catalog.fee, tickSpacing: catalog.tick_spacing, hooks: catalog.hooks as Address }],
      blockNumber, gas: 30_000_000n });
    if (!result || typeof result !== 'object' || !('coreAmount0' in result) || !('coreAmount1' in result)
      || !('sqrtPriceX96' in result) || !('hasCustomAccounting' in result)
      || typeof result.coreAmount0 !== 'bigint' || typeof result.coreAmount1 !== 'bigint'
      || typeof result.sqrtPriceX96 !== 'bigint' || result.coreAmount0 < 0n || result.coreAmount1 < 0n
      || result.sqrtPriceX96 <= 0n || !hasStandardAccounting(result)) return null;
    return { blockNumber, coreAmount0: result.coreAmount0, coreAmount1: result.coreAmount1, sqrtPriceX96: result.sqrtPriceX96 };
  } catch { return null; }
}
