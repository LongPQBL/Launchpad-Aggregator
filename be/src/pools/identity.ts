import { encodeAbiParameters, isAddress, isHex, keccak256, type Address, type Hash } from 'viem';

export interface RawV4Initialize {
  chainId: number;
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export interface VerifiedPool {
  chainId: number;
  protocol: 'uniswap_v4';
  poolId: Hash;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  blockNumber: bigint;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
  verified: true;
}

/** Verify the PoolManager Initialize event against the canonical V4 PoolKey hash. */
export function verifyV4Initialize(raw: RawV4Initialize): VerifiedPool | null {
  if (!Number.isSafeInteger(raw.chainId) || raw.chainId <= 0
    || !isAddress(raw.currency0) || !isAddress(raw.currency1) || !isAddress(raw.hooks)
    || !isHex(raw.poolId, { strict: true }) || raw.poolId.length !== 66
    || !isHex(raw.blockHash, { strict: true }) || raw.blockHash.length !== 66
    || !isHex(raw.txHash, { strict: true }) || raw.txHash.length !== 66
    || !Number.isInteger(raw.fee) || raw.fee < 0 || raw.fee > 0xffffff
    || !Number.isInteger(raw.tickSpacing) || raw.tickSpacing <= 0 || raw.tickSpacing > 0x7fffff
    || raw.blockNumber < 0n || !Number.isSafeInteger(raw.logIndex) || raw.logIndex < 0) return null;
  const currency0 = raw.currency0.toLowerCase() as Address;
  const currency1 = raw.currency1.toLowerCase() as Address;
  const hooks = raw.hooks.toLowerCase() as Address;
  if (currency0 >= currency1) return null;
  const expectedId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [currency0, currency1, raw.fee, raw.tickSpacing, hooks],
  ));
  if (expectedId !== raw.poolId.toLowerCase()) return null;
  return {
    chainId: raw.chainId, protocol: 'uniswap_v4', poolId: expectedId, currency0, currency1,
    fee: raw.fee, tickSpacing: raw.tickSpacing, hooks, blockNumber: raw.blockNumber,
    blockHash: raw.blockHash.toLowerCase() as Hash, txHash: raw.txHash.toLowerCase() as Hash,
    logIndex: raw.logIndex, verified: true,
  };
}
