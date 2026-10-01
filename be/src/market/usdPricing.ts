import type { Address } from 'viem';
import { parseAbi } from 'viem';

export interface UsdPriceClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

// Verified directly against Robinhood Chain mainnet 2026-10-01 — eth_call to latestRoundData()
// on this address returned a live, sane ETH/USD price. Source of truth for addresses:
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
const FEEDS: Record<string, Address> = {
  ETH: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9',
  USDC: '0x9e6f4605992a899eE2999999F3Ec80C41F452546',
  USDT: '0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1',
};

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { priceUsd: number; updatedAt: number; fetchedAt: number }>();

export async function readUsdPrice(client: UsdPriceClient, quoteAssetSymbol: string, now: () => number = Date.now):
Promise<{ priceUsd: number; updatedAt: number } | null> {
  const feedAddress = FEEDS[quoteAssetSymbol];
  if (!feedAddress) return null;
  const cached = cache.get(quoteAssetSymbol);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt };

  const [decimalsResult, roundData] = await Promise.all([
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'decimals' }),
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'latestRoundData' }),
  ]);
  if (typeof decimalsResult !== 'number' || !Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || typeof roundData[3] !== 'bigint') {
    throw new Error(`Invalid Chainlink feed response for ${quoteAssetSymbol}`);
  }
  const priceUsd = Number(roundData[1]) / 10 ** decimalsResult;
  const updatedAt = Number(roundData[3]);
  cache.set(quoteAssetSymbol, { priceUsd, updatedAt, fetchedAt: now() });
  return { priceUsd, updatedAt };
}
