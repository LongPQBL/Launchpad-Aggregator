'use client';

import type { Address } from 'viem';
import { useReadContract } from 'wagmi';
import { v3PoolAbi } from './v3PoolAbi';

export interface PoolFee {
  fee: number | null;
  isLoading: boolean;
}

// A pool's fee tier is immutable, but this app never guesses it (a wrong fee targets a
// different pool entirely, or reverts) — see this plan's Review Focus.
export function usePoolFee(poolAddress: Address | undefined): PoolFee {
  const { data, isLoading } = useReadContract({
    address: poolAddress,
    abi: v3PoolAbi,
    functionName: 'fee',
    query: { enabled: Boolean(poolAddress) },
  });

  return { fee: data ?? null, isLoading };
}
