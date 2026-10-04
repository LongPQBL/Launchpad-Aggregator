import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { __resetUsdPriceCacheForTests, readUsdPrice, type UsdPriceClient } from './usdPricing.js';
import { upsertQuoteFeed } from './quotePricing/feedRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });

const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
// Real WETH quote-asset address seen on 166,479 real launches in the live DB (2026-10-01) —
// final-review Critical 1: a symbol-keyed map only matched the literal string 'ETH', so every one
// of those launches silently got null USD pricing despite being ETH-denominated.
const WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NVDA_ADDRESS = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const ETH_USD_FEED = '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9';
const USDG_USD_FEED = '0x61b7e5650328764b076a108eff5fa7282a1b9ad2';
const NVDA_USD_FEED = '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15';
const UNSEEDED_ADDRESS = '0x1111111111111111111111111111111111111111';

beforeAll(async () => {
  const now = new Date();
  for (const feed of [
    { quoteAssetAddress: ETH_ADDRESS, feedAddress: ETH_USD_FEED },
    { quoteAssetAddress: WETH_ADDRESS, feedAddress: ETH_USD_FEED },
    { quoteAssetAddress: USDG_ADDRESS, feedAddress: USDG_USD_FEED },
    { quoteAssetAddress: NVDA_ADDRESS, feedAddress: NVDA_USD_FEED },
  ] as const) {
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: feed.quoteAssetAddress, feedAddress: feed.feedAddress,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now });
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = 4663 AND quote_asset_address = ANY($1)',
    [[ETH_ADDRESS, WETH_ADDRESS, USDG_ADDRESS, NVDA_ADDRESS, '0x9999999999999999999999999999999999feed']]);
  await pool.end();
});

beforeEach(() => {
  __resetUsdPriceCacheForTests();
});

describe('readUsdPrice', () => {
  it('reads USDG/USD from its verified Chainlink feed', async () => {
    const readContract = vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      expect(address.toLowerCase()).toBe(USDG_USD_FEED);
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 99992674n, 1n, 1_790_782_723n, 1n];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readUsdPrice(pool, { readContract }, USDG_ADDRESS, () => 1_790_859_457_000);
    expect(result).toEqual({ priceUsd: 0.99992674, updatedAt: 1_790_782_723, source: 'chainlink' });
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('maps a canonical Robinhood Stock Token address to its USD feed', async () => {
    const readContract = vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      expect(address.toLowerCase()).toBe(NVDA_USD_FEED);
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 180_00000000n, 1n, 1_790_859_457n, 1n];
      throw new Error(`unexpected ${functionName}`);
    });
    expect(await readUsdPrice(pool, { readContract }, NVDA_ADDRESS, () => 1_790_859_457_000))
      .toEqual({ priceUsd: 180, updatedAt: 1_790_859_457, source: 'chainlink' });
  });

  it('reads a feed resolved from the persisted quote_usd_feeds table, not a hardcoded map', async () => {
    const freshQuote = '0x9999999999999999999999999999999999feed';
    await upsertQuoteFeed(pool, { chainId: 4663, quoteAssetAddress: freshQuote, feedAddress: USDG_USD_FEED,
      aggregatorAddress: null, discoverySource: 'test', verificationStatus: 'verified', now: new Date() });
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 99992674n, 1n, 1_790_782_723n, 1n];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readUsdPrice(pool, { readContract }, freshQuote, () => 1_790_859_457_000);
    expect(result).toEqual({ priceUsd: 0.99992674, updatedAt: 1_790_782_723, source: 'chainlink' });
  });

  it('returns null without calling the RPC for a quote asset address with no verified feed row', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(pool, client, UNSEEDED_ADDRESS, Date.now);
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('matches a quote asset address case-insensitively', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 269170223591n, 1790859457n, 1790859457n, 1n];
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(pool, client, WETH_ADDRESS.toUpperCase(), () => 1_790_859_457_000);
    expect(result).not.toBeNull();
  });
});

describe('readUsdPrice — known feed', () => {
  function roundData(answerUsd8dp: bigint, updatedAt: number) {
    return [1n, answerUsd8dp, BigInt(updatedAt), BigInt(updatedAt), 1n];
  }

  it('reads the ETH/USD feed for the native (zero-address) quote asset and scales by decimals()', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    // Frozen clock matching the fixture's updatedAt — using the real wall clock here would make
    // this test fail every day further past 1790859457 + 24h, since the code correctly rejects a
    // stale feed answer (final-review Important 4).
    const result = await readUsdPrice(pool, client, ETH_ADDRESS, () => 1_790_859_457_000);
    expect(result).toEqual({ priceUsd: 2691.70223591, updatedAt: 1790859457, source: 'chainlink' });
  });

  it('reads the same ETH/USD feed for the WETH quote asset address', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(pool, client, WETH_ADDRESS, () => 1_790_859_457_000);
    expect(result).toEqual({ priceUsd: 2691.70223591, updatedAt: 1790859457, source: 'chainlink' });
  });

  it('serves the cached price on a second call within 60s, without a second RPC round-trip', async () => {
    let calls = 0;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      calls += 1;
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(300000000000n, 1000);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    let fakeNow = 1_000_000;
    const now = () => fakeNow;
    await readUsdPrice(pool, client, ETH_ADDRESS, now);
    const callsAfterFirst = calls;
    fakeNow += 59_000;
    const second = await readUsdPrice(pool, client, ETH_ADDRESS, now);
    expect(calls).toBe(callsAfterFirst); // no new RPC call
    expect(second).toEqual({ priceUsd: 3000, updatedAt: 1000, source: 'chainlink' });
  });

  it('re-reads after the 60s cache expires', async () => {
    let fakeNow = 1_000_000;
    const now = () => fakeNow;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(fakeNow === 1_000_000 ? 100000000000n : 200000000000n, Math.floor(fakeNow / 1000));
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const first = await readUsdPrice(pool, client, ETH_ADDRESS, now);
    fakeNow += 61_000;
    const second = await readUsdPrice(pool, client, ETH_ADDRESS, now);
    expect(first!.priceUsd).toBe(1000);
    expect(second!.priceUsd).toBe(2000);
  });

  it('dedupes two concurrent calls for the same address into a single RPC round-trip (final-review Important 5)', async () => {
    let calls = 0;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      calls += 1;
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const frozenNow = () => 1_790_859_457_000;
    const [a, b] = await Promise.all([readUsdPrice(pool, client, ETH_ADDRESS, frozenNow), readUsdPrice(pool, client, ETH_ADDRESS, frozenNow)]);
    expect(a).toEqual(b);
    expect(calls).toBe(2); // one decimals() + one latestRoundData() call, not four
  });

  it('rejects a non-positive answer instead of returning a nonsensical price (final-review Important 4)', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(0n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    await expect(readUsdPrice(pool, client, ETH_ADDRESS)).rejects.toThrow(/invalid/i);
  });

  it('rejects an answer older than 24 hours instead of silently serving a stale price (final-review Important 4)', async () => {
    const nowSeconds = 1_790_859_457;
    const staleUpdatedAt = nowSeconds - 25 * 3600;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, staleUpdatedAt);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    await expect(readUsdPrice(pool, client, ETH_ADDRESS, () => nowSeconds * 1000)).rejects.toThrow(/stale/i);
  });

  it('rejects a price too large to represent as a finite number', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(10n ** 400n, 1_790_859_457);
      throw new Error(`unexpected ${functionName}`);
    });
    await expect(readUsdPrice(pool, { readContract }, ETH_ADDRESS, () => 1_790_859_457_000)).rejects.toThrow(/invalid/i);
  });

  it('rejects a feed timestamp more than five minutes in the future', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1_790_859_457 + 3600);
      throw new Error(`unexpected ${functionName}`);
    });
    await expect(readUsdPrice(pool, { readContract }, ETH_ADDRESS, () => 1_790_859_457_000)).rejects.toThrow(/future/i);
  });
});
