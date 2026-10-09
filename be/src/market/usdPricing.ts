import type { Address } from 'viem';
import { parseAbi } from 'viem';
import type { Pool } from 'pg';
import { assertClientMatchesChain } from '../chains/registry.js';
import { resolveVerifiedFeed } from './quotePricing/feedRegistry.js';

export interface UsdPriceClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[];
    blockNumber?: bigint; gas?: bigint }): Promise<unknown>;
  getBlockNumber?(): Promise<bigint>;
  // A real viem client declares its chain; chain-scoped reads verify it matches (see assertClientMatchesChain).
  chain?: { id: number } | undefined;
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
// A feed that fails (stale, RPC error, malformed answer) is remembered briefly: without this, every request
// that needs the price repeats the failing RPC pair, so one broken feed multiplies into an RPC storm.
const FAILURE_TTL_MS = 15_000;
// Keyed by chain as well as address: the same address can mean different assets on different chains.
const cache = new Map<string, { priceUsd: number; updatedAt: number; fetchedAt: number }>();
const failures = new Map<string, { error: Error; failedAt: number }>();
// A feed's decimals() never changes, so it is read once per feed instead of with every price refresh.
const feedDecimals = new Map<string, number>();
// Dedupes concurrent requests for the same asset into one RPC round-trip (final-review Important 5): without
// this, N concurrent listLaunches rows sharing one quote asset each fire their own latestRoundData() on a cold cache.
const inFlight = new Map<string, Promise<UsdPrice | null>>();

async function readFeedDecimals(client: UsdPriceClient, chainId: number, feedAddress: Address, quoteAssetAddress: string): Promise<number> {
  const key = `${chainId}:${feedAddress.toLowerCase()}`;
  const known = feedDecimals.get(key);
  if (known !== undefined) return known;
  const decimals = await client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'decimals' });
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid Chainlink decimals for ${quoteAssetAddress}`);
  }
  feedDecimals.set(key, decimals);
  return decimals;
}

async function fetchUsdPrice(client: UsdPriceClient, chainId: number, feedAddress: Address, quoteAssetAddress: string, now: () => number):
Promise<UsdPrice | null> {
  const [decimals, roundData] = await Promise.all([
    readFeedDecimals(client, chainId, feedAddress, quoteAssetAddress),
    client.readContract({ address: feedAddress, abi: aggregatorAbi, functionName: 'latestRoundData' }),
  ]);
  if (!Array.isArray(roundData) || typeof roundData[1] !== 'bigint' || typeof roundData[3] !== 'bigint') {
    throw new Error(`Invalid Chainlink feed response for ${quoteAssetAddress}`);
  }
  const priceUsd = Number(roundData[1]) / 10 ** decimals;
  const updatedAt = Number(roundData[3]);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error(`Invalid Chainlink price for ${quoteAssetAddress}`);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error(`Invalid Chainlink timestamp for ${quoteAssetAddress}`);
  const ageMs = now() - updatedAt * 1000;
  if (ageMs > MAX_PRICE_AGE_MS) throw new Error(`Stale Chainlink price for ${quoteAssetAddress} (updatedAt=${updatedAt})`);
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error(`Future Chainlink timestamp for ${quoteAssetAddress} (updatedAt=${updatedAt})`);
  cache.set(`${chainId}:${quoteAssetAddress}`, { priceUsd, updatedAt, fetchedAt: now() });
  return { priceUsd, updatedAt, source: 'chainlink' };
}

// Test-only seam: the module-level caches persist across `it()` blocks in the same file (vitest does not
// reset module state between tests). Not used by production code.
export function __resetUsdPriceCacheForTests(): void {
  cache.clear();
  failures.clear();
  feedDecimals.clear();
  inFlight.clear();
}

export async function readUsdPrice(pool: Pool, client: UsdPriceClient, chainId: number, quoteAssetAddress: string,
  now: () => number = Date.now): Promise<UsdPrice | null> {
  assertClientMatchesChain(client, chainId);
  const address = quoteAssetAddress.toLowerCase();
  const key = `${chainId}:${address}`;
  const feed = await resolveVerifiedFeed(pool, chainId, address);
  if (!feed) return null;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt, source: 'chainlink' };
  const failed = failures.get(key);
  if (failed && now() - failed.failedAt < FAILURE_TTL_MS) throw failed.error;

  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchUsdPrice(client, chainId, feed.feedAddress, address, now)
    .then((price) => { failures.delete(key); return price; })
    .catch((error: unknown) => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      failures.set(key, { error: wrapped, failedAt: now() });
      throw wrapped;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
