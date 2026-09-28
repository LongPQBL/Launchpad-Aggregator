import type { Address } from 'viem';
import { v1GraduationAbi, v1TokenAbi } from './abi.js';
import type { V1TokenMetadata } from './adapter.js';

export interface V1ReadClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly Address[]; blockNumber?: bigint }): Promise<unknown>;
}

export async function readV1TokenMetadata(client: V1ReadClient, token: Address): Promise<V1TokenMetadata> {
  const [name, symbol, decimals, liquidityPool] = await Promise.all([
    client.readContract({ address: token, abi: v1TokenAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: v1TokenAbi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: v1TokenAbi, functionName: 'decimals' }),
    client.readContract({ address: token, abi: v1TokenAbi, functionName: 'liquidityPool' }),
  ]);
  if (typeof name !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number' || typeof liquidityPool !== 'string') {
    throw new Error('Invalid pons v1 token metadata');
  }
  return { name, symbol, decimals, liquidityPool: liquidityPool as Address };
}

export async function readV1Graduation(client: V1ReadClient, token: Address, factory: Address, blockNumber?: bigint): Promise<boolean> {
  const result = await client.readContract({
    address: factory,
    abi: v1GraduationAbi,
    functionName: 'graduationStatus',
    args: [token],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (!Array.isArray(result) || typeof result[2] !== 'boolean') throw new Error('Invalid pons v1 graduation status');
  return result[2];
}
