import { parseAbi, type Address } from 'viem';

export interface DiscoveryClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function aggregator() view returns (address)',
]);

export async function discoverAndVerifyFeed(
  client: DiscoveryClient, lookupBySymbol: (address: string) => Promise<Address | null>, quoteAssetAddress: Address,
): Promise<{ feedAddress: Address; aggregatorAddress: Address } | null> {
  const candidate = await lookupBySymbol(quoteAssetAddress);
  if (!candidate) return null;
  try {
    const [decimalsResult, roundData, aggregatorAddress] = await Promise.all([
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'decimals' }),
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'latestRoundData' }),
      client.readContract({ address: candidate, abi: aggregatorAbi, functionName: 'aggregator' }),
    ]);
    if (typeof decimalsResult !== 'number' || !Number.isInteger(decimalsResult) || decimalsResult < 0 || decimalsResult > 255) return null;
    if (!Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || roundData[1] <= 0n) return null;
    if (typeof aggregatorAddress !== 'string' || !aggregatorAddress.startsWith('0x')) return null;
    return { feedAddress: candidate, aggregatorAddress: aggregatorAddress as Address };
  } catch {
    return null;
  }
}
