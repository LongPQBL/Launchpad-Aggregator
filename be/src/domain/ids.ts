import type { Address, Hash } from 'viem';
import type { VenueKind } from './types.js';

export function tokenKey(chainId: number, tokenAddress: Address): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

export function venueKey(chainId: number, kind: VenueKind, ref: string): string {
  return `${chainId}:${kind}:${ref.toLowerCase()}`;
}

export function logKey(chainId: number, blockHash: Hash, txHash: Hash, logIndex: number): string {
  return `${chainId}:${blockHash.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}
