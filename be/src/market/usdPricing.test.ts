import { describe, expect, it, vi } from 'vitest';
import { readUsdPrice, type UsdPriceClient } from './usdPricing.js';

describe('readUsdPrice', () => {
  it('returns null without calling the RPC for a quote asset with no known feed', async () => {
    const readContract = vi.fn();
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(client, 'SPCX');
    expect(result).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe('readUsdPrice — known feed', () => {
  function roundData(answerUsd8dp: bigint, updatedAt: number) {
    return [1n, answerUsd8dp, BigInt(updatedAt), BigInt(updatedAt), 1n];
  }

  it('reads the ETH/USD feed and scales the answer by decimals()', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(269170223591n, 1790859457);
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const result = await readUsdPrice(client, 'ETH');
    expect(result).toEqual({ priceUsd: 2691.70223591, updatedAt: 1790859457 });
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
    let fakeNow = 0;
    const now = () => fakeNow;
    await readUsdPrice(client, 'USDC', now);
    const callsAfterFirst = calls;
    fakeNow = 59_000;
    const second = await readUsdPrice(client, 'USDC', now);
    expect(calls).toBe(callsAfterFirst); // no new RPC call
    expect(second).toEqual({ priceUsd: 3000, updatedAt: 1000 });
  });

  it('re-reads after the 60s cache expires', async () => {
    let fakeNow = 0;
    const now = () => fakeNow;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return roundData(fakeNow === 0 ? 100000000000n : 200000000000n, Math.floor(fakeNow / 1000));
      throw new Error(`unexpected ${functionName}`);
    });
    const client: UsdPriceClient = { readContract };
    const first = await readUsdPrice(client, 'USDT', now);
    fakeNow = 61_000;
    const second = await readUsdPrice(client, 'USDT', now);
    expect(first!.priceUsd).toBe(1000);
    expect(second!.priceUsd).toBe(2000);
  });
});
