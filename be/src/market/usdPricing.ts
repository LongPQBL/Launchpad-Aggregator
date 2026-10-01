import type { Address } from 'viem';
import { parseAbi } from 'viem';
import { quoteFeedRegistry } from './quoteFeedRegistry.js';

export interface UsdPriceClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface UsdPrice { priceUsd: number; updatedAt: number; source: 'chainlink' }

// Keyed by lowercase quote-asset ADDRESS, not symbol — final-review Critical 1: 166,479 real
// launches (2026-10-01 live DB) use the WETH quote-asset address, not the literal string 'ETH',
// and a symbol-keyed map silently priced none of them. Pons' zero-address convention for native
// ETH is also included. Feed address verified directly against Robinhood Chain mainnet
// 2026-10-01 — eth_call to latestRoundData() returned a live, sane ETH/USD price. Source of
// truth for the feed address: https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
// USDC/USDT are not mapped yet: no real launch in the live DB uses either as a quote asset, and
// this project does not fabricate unverified token addresses — add them (with verified Robinhood
// Chain token addresses) if/when a launch actually needs one.
const ETH_USD_FEED: Address = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const FEEDS: Record<string, Address> = {
  '0x0000000000000000000000000000000000000000': ETH_USD_FEED, // native ETH (Pons' quote-asset convention)
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': ETH_USD_FEED, // WETH — the actual quote-asset address real V1 launches use
  [USDG_ADDRESS]: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2', // USDG/USD on Robinhood Chain
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', // NVDA Stock Token
};

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

export async function readUsdPrice(client: UsdPriceClient, quoteAssetAddress: string, now: () => number = Date.now,
  registry: { resolve(address: string): Promise<Address | null> } = quoteFeedRegistry):
Promise<UsdPrice | null> {
  const key = quoteAssetAddress.toLowerCase();
  const feedAddress = FEEDS[key] ?? await registry.resolve(key);
  if (!feedAddress) return null;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { priceUsd: cached.priceUsd, updatedAt: cached.updatedAt, source: 'chainlink' };

  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchUsdPrice(client, feedAddress, key, now).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
