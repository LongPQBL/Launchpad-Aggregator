'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Abi, Address } from 'viem';
import { robinhoodChain } from '@/wallet/config';

interface QuoterSimulationParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[] | undefined;
  enabled: boolean;
}

const keyOf = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

/**
 * Simulates a quoter call on the public client. wagmi's own useSimulateContract stays disabled until a wallet connector is
 * connected, but the V3/V4 quoters need no account, so a visitor with no wallet still gets a quote.
 */
export function useQuoterSimulation<TResult>({ address, abi, functionName, args, enabled }: QuoterSimulationParams) {
  const client = usePublicClient({ chainId: robinhoodChain.id });
  return useQuery({
    queryKey: ['quoter-simulation', address.toLowerCase(), functionName, keyOf(args)],
    enabled: enabled && Boolean(client) && args !== undefined,
    retry: 1,
    queryFn: async () => {
      const { result } = await client!.simulateContract({ address, abi, functionName, args } as never);
      return { result: result as TResult };
    },
  });
}
