import { parseAbi, type Address } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const RESERVES_LENS = '0x0000001b173C3bbF3984D417d8614E3eed34865B' as Address;
const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct PoolTVL { uint256 coreAmount0; uint256 coreAmount1; uint256 hookReserves0; uint256 hookReserves1; uint256 hookEffective0; uint256 hookEffective1; uint160 sqrtPriceX96; int24 tick; uint128 activeLiquidity; uint256 blockNumber; address statsProvider; uint16 hookPermissions; bool hasCustomAccounting; uint8 statsStatus; }',
  'function getPoolTVL(address manager, PoolKey key) view returns (PoolTVL result)',
]);

export interface LensPoolKey { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }
export interface LensSnapshot { blockNumber: bigint; coreAmount0: bigint; coreAmount1: bigint; sqrtPriceX96: bigint }

/** Current core reserves + spot price of a V4 pool from the reserves lens; null if unavailable or invalid. */
export async function readLensSnapshot(client: UsdPriceClient | undefined, catalog: LensPoolKey): Promise<LensSnapshot | null> {
  if (!client?.getBlockNumber) return null;
  try {
    const blockNumber = await client.getBlockNumber();
    const result = await client.readContract({ address: RESERVES_LENS, abi: lensAbi, functionName: 'getPoolTVL',
      args: [POOL_MANAGER, { currency0: catalog.currency0 as Address, currency1: catalog.currency1 as Address,
        fee: catalog.fee, tickSpacing: catalog.tick_spacing, hooks: catalog.hooks as Address }],
      blockNumber, gas: 30_000_000n });
    if (!result || typeof result !== 'object' || !('coreAmount0' in result) || !('coreAmount1' in result)
      || !('sqrtPriceX96' in result) || !('hasCustomAccounting' in result)
      || typeof result.coreAmount0 !== 'bigint' || typeof result.coreAmount1 !== 'bigint'
      || typeof result.sqrtPriceX96 !== 'bigint' || result.coreAmount0 < 0n || result.coreAmount1 < 0n
      || result.sqrtPriceX96 <= 0n || result.hasCustomAccounting !== false) return null;
    return { blockNumber, coreAmount0: result.coreAmount0, coreAmount1: result.coreAmount1, sqrtPriceX96: result.sqrtPriceX96 };
  } catch { return null; }
}
