import { encodeAbiParameters, isAddress, keccak256, parseAbi, type Address } from 'viem';

const PONS_HOOK: Address = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const POOL_MANAGER: Address = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const RESERVES_LENS: Address = '0x0000001b173C3bbF3984D417d8614E3eed34865B';

const curveAbi = parseAbi(['function realQuoteReserve() view returns (uint256)']);
const v3Abi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct PoolTVL { uint256 coreAmount0; uint256 coreAmount1; uint256 hookReserves0; uint256 hookReserves1; uint256 hookEffective0; uint256 hookEffective1; uint160 sqrtPriceX96; int24 tick; uint128 activeLiquidity; uint256 blockNumber; address statsProvider; uint16 hookPermissions; bool hasCustomAccounting; uint8 statsStatus; }',
  'function getPoolTVL(address manager, PoolKey key) view returns (PoolTVL result)',
]);

export interface TvlReadClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string;
    args?: readonly unknown[]; blockNumber: bigint; gas?: bigint }): Promise<unknown>;
}

export interface VenueAmountInput {
  kind: 'curve' | 'v3_pool' | 'v4_pool'; ref: string; token: string; quote: string;
  blockNumber: bigint; v4PoolFee?: number | null; v4TickSpacing?: number | null;
}

export interface VenueAmounts {
  tokenRaw: bigint; quoteRaw: bigint; blockNumber: bigint;
  basis: 'curve_real_quote' | 'pool_custody' | 'pool_principal';
  sqrtPriceX96: bigint | null;
  tokenIsCurrency0: boolean | null;
}

function isAmount(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n; }

export async function readVenueAmounts(client: TvlReadClient, input: VenueAmountInput): Promise<VenueAmounts | null> {
  if (!isAddress(input.token) || !isAddress(input.quote) || input.token.toLowerCase() === input.quote.toLowerCase()) return null;
  const token = input.token.toLowerCase() as Address;
  const quote = input.quote.toLowerCase() as Address;
  const at = input.blockNumber;
  try {
    if (input.kind === 'curve') {
      if (!isAddress(input.ref)) return null;
      const quoteRaw = await client.readContract({ address: input.ref as Address, abi: curveAbi,
        functionName: 'realQuoteReserve', blockNumber: at });
      return isAmount(quoteRaw) ? { tokenRaw: 0n, quoteRaw, blockNumber: at,
        basis: 'curve_real_quote', sqrtPriceX96: null, tokenIsCurrency0: null } : null;
    }
    if (input.kind === 'v3_pool') {
      if (!isAddress(input.ref) || quote === '0x0000000000000000000000000000000000000000') return null;
      const pool = input.ref as Address;
      const [token0, token1, slot0, tokenRaw, quoteRaw] = await Promise.all([
        client.readContract({ address: pool, abi: v3Abi, functionName: 'token0', blockNumber: at }),
        client.readContract({ address: pool, abi: v3Abi, functionName: 'token1', blockNumber: at }),
        client.readContract({ address: pool, abi: v3Abi, functionName: 'slot0', blockNumber: at }),
        client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: at }),
        client.readContract({ address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: at }),
      ]);
      if (typeof token0 !== 'string' || typeof token1 !== 'string'
        || !((token0.toLowerCase() === token && token1.toLowerCase() === quote)
          || (token0.toLowerCase() === quote && token1.toLowerCase() === token))
        || !Array.isArray(slot0) || typeof slot0[0] !== 'bigint'
        || slot0[0] <= 0n || !isAmount(tokenRaw) || !isAmount(quoteRaw)) return null;
      return { tokenRaw, quoteRaw, blockNumber: at, basis: 'pool_custody', sqrtPriceX96: slot0[0],
        tokenIsCurrency0: token0.toLowerCase() === token };
    }
    if (input.kind === 'v4_pool') {
      const fee = input.v4PoolFee;
      const spacing = input.v4TickSpacing;
      if (fee !== 0 || typeof spacing !== 'number' || !Number.isInteger(spacing) || spacing <= 0) return null;
      const [currency0, currency1] = token < quote ? [token, quote] : [quote, token];
      const poolId = keccak256(encodeAbiParameters([
        { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
      ], [currency0, currency1, fee, spacing, PONS_HOOK]));
      if (poolId.toLowerCase() !== input.ref.toLowerCase()) return null;
      const result = await client.readContract({ address: RESERVES_LENS, abi: lensAbi, functionName: 'getPoolTVL',
        args: [POOL_MANAGER, { currency0, currency1, fee, tickSpacing: spacing, hooks: PONS_HOOK }],
        blockNumber: at, gas: 30_000_000n });
      if (!result || typeof result !== 'object' || !('coreAmount0' in result) || !('coreAmount1' in result)
        || !('sqrtPriceX96' in result) || !isAmount(result.coreAmount0) || !isAmount(result.coreAmount1)
        || typeof result.sqrtPriceX96 !== 'bigint' || result.sqrtPriceX96 <= 0n) return null;
      return { tokenRaw: token === currency0 ? result.coreAmount0 : result.coreAmount1,
        quoteRaw: quote === currency0 ? result.coreAmount0 : result.coreAmount1,
        blockNumber: at, basis: 'pool_principal', sqrtPriceX96: result.sqrtPriceX96,
        tokenIsCurrency0: token === currency0 };
    }
  } catch { return null; }
  return null;
}
