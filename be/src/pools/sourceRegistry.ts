import { isAddress, isHex, type Address, type Hash } from 'viem';

export const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
export const SOURCE_DEPLOYMENT_BLOCK = { uniswap_v3: 8930n, uniswap_v2: 8928n } as const;
export type AdditionalPoolProtocol = keyof typeof SOURCE_DEPLOYMENT_BLOCK;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface RawCreated {
  chainId: number; factoryAddress: string; token0: string; token1: string;
  poolAddress?: string; pairAddress?: string; fee?: number; tickSpacing?: number;
  blockNumber: bigint; blockHash: string; txHash: string; logIndex: number;
}
export interface VerifiedAdditionalPool {
  chainId: number; protocol: AdditionalPoolProtocol; poolId: Address;
  currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address;
  blockNumber: bigint; blockHash: Hash; txHash: Hash; logIndex: number; verified: true;
}
function verify(raw: RawCreated, protocol: AdditionalPoolProtocol): VerifiedAdditionalPool | null {
  const factory = protocol === 'uniswap_v3' ? V3_FACTORY : V2_FACTORY;
  const poolId = protocol === 'uniswap_v3' ? raw.poolAddress : raw.pairAddress;
  if (raw.chainId !== 4663 || raw.factoryAddress.toLowerCase() !== factory
    || !isAddress(raw.token0) || !isAddress(raw.token1) || !poolId || !isAddress(poolId)
    || poolId.toLowerCase() === ZERO_ADDRESS || !isHex(raw.blockHash, { strict: true })
    || raw.blockHash.length !== 66 || !isHex(raw.txHash, { strict: true }) || raw.txHash.length !== 66
    || !Number.isSafeInteger(raw.logIndex) || raw.logIndex < 0
    || raw.blockNumber < SOURCE_DEPLOYMENT_BLOCK[protocol]) return null;
  const currency0 = raw.token0.toLowerCase() as Address;
  const currency1 = raw.token1.toLowerCase() as Address;
  if (currency0 === ZERO_ADDRESS || currency0 >= currency1) return null;
  const fee = protocol === 'uniswap_v3' ? raw.fee : 3000;
  const tickSpacing = protocol === 'uniswap_v3' ? raw.tickSpacing : 0;
  if (!Number.isSafeInteger(fee) || fee! < 0 || fee! > 1_000_000
    || !Number.isSafeInteger(tickSpacing) || (protocol === 'uniswap_v3' && (tickSpacing! < 1 || tickSpacing! > 32767))) return null;
  return { chainId: raw.chainId, protocol, poolId: poolId.toLowerCase() as Address,
    currency0, currency1, fee: fee!, tickSpacing: tickSpacing!, hooks: ZERO_ADDRESS,
    blockNumber: raw.blockNumber, blockHash: raw.blockHash.toLowerCase() as Hash,
    txHash: raw.txHash.toLowerCase() as Hash, logIndex: raw.logIndex, verified: true };
}
export function verifyV3PoolCreated(raw: RawCreated): VerifiedAdditionalPool | null { return verify(raw, 'uniswap_v3'); }
export function verifyV2PairCreated(raw: RawCreated): VerifiedAdditionalPool | null { return verify(raw, 'uniswap_v2'); }
