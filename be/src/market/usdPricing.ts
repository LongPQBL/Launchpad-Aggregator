import type { Address } from 'viem';
import { parseAbi } from 'viem';
import type { Pool } from 'pg';
import { resolveVerifiedFeed } from './quotePricing/feedRegistry.js';

export interface UsdPriceClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[];
    blockNumber?: bigint; gas?: bigint }): Promise<unknown>;
  getBlockNumber?(): Promise<bigint>;
}

export interface UsdPrice { priceUsd: number; updatedAt: number; source: 'chainlink' }

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

// Conservative bound: chain.link's Robinhood tokenized-equity feeds publish an 86400s (24h)
// heartbeat; this project has not independently confirmed the ETH/USD feed's own heartbeat, so
// 24h is used as a generous-but-real staleness ceiling rather than inventing a tighter number.
const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { priceUsd: number; updatedAt: number; fetchedAt: number }>();
// Dedupes concurrent requests for the same address into one RPC round-trip (final-review
// Important 5): without this, N concurrent listLaunches rows sharing one quote asset each fire
// their own latestRoundData()/decimals() pair on a cold cache.
const inFlight = new Map<string, Promise<UsdPrice | null>>();

async function fetchUsdPrice(client: UsdPriceClient, feedAddress: Address, quoteAssetAddress: string, now: () => number):
Promise<UsdPrice | null> {
  const [decimalsResult, roundData] = await Promise.all([
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'decimals' }),
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'latestRoundData' }),
  ]);
  if (typeof decimalsResult !== 'number' || !Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || typeof roundData[3] !== 'bigint') {
    throw new Error(`Invalid Chainlink feed response for ${quoteAssetAddress}`);
  }
  if (!Number.isInteger(decimalsResult) || decimalsResult < 0 || decimalsResult > 255) {
    throw new Error(`Invalid Chainlink decimals for ${quoteAssetAddress}`);
  }
  const priceUsd = Number(roundData[1]) / 10 ** decimalsResult;
  const updatedAt = Number(roundData[3]);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error(`Invalid Chainlink price for ${quoteAssetAddress}`);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error(`Invalid Chainlink timestamp for ${quoteAssetAddress}`);
  const ageMs = now() - updatedAt * 1000;
  if (ageMs > MAX_PRICE_AGE_MS) throw new Error(`Stale Chainlink price for ${quoteAssetAddress} (updatedAt=${updatedAt})`);
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error(`Future Chainlink timestamp for ${quoteAssetAddress} (updatedAt=${updatedAt})`);
  cache.set(quoteAssetAddress, { priceUsd, updatedAt, fetchedAt: now() });
  return { priceUsd, updatedAt, source: 'chainlink' };
}

// Test-only seam: the module-level cache/in-flight maps persist across `it()` blocks in the same
// file (vitest does not reset module state between tests), so tests that reuse a real FEEDS key
// (there are only two) need a way to isolate themselves. Not used by production code.
export function __resetUsdPriceCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export async function readUsdPrice(pool: Pool, client: UsdPriceClient, quoteAssetAddress: string,
  now: () => number = Date.now): Promise<UsdPrice | null> {
  const key = quoteAssetAddress.toLowerCase();
  const feed = await resolveVerifiedFeed(pool, 4663, key);
  if (!feed) return null;
  const feedAddress = feed.feedAddress;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt, source: 'chainlink' };

  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchUsdPrice(client, feedAddress, key, now).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
