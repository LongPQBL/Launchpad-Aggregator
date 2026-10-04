import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { discoverAndVerifyFeed } from './feedDiscovery.js';

const quote = '0xquote00000000000000000000000000000f001' as Address;
const candidateFeed = '0xcandidatefeed000000000000000000000f002' as Address;
const aggregator = '0xaggregator000000000000000000000000f003' as Address;

describe('discoverAndVerifyFeed', () => {
  it('verifies a candidate feed on-chain (decimals + a sane latestRoundData) and resolves its aggregator address', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address.toLowerCase() === candidateFeed.toLowerCase()) {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') return [1n, 100_000_000n, 1n, 1_790_000_000n, 1n];
        if (functionName === 'aggregator') return aggregator;
      }
      throw new Error(`unexpected ${address} ${functionName}`);
    }) };
    const result = await discoverAndVerifyFeed(client, lookupBySymbol, quote);
    expect(result).toEqual({ feedAddress: candidateFeed, aggregatorAddress: aggregator });
  });

  it('returns null when the directory has no candidate for this address at all', async () => {
    const lookupBySymbol = vi.fn(async () => null);
    const client = { readContract: vi.fn() };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('returns null (never a fabricated feed) when the candidate address does not behave like a real Chainlink feed on-chain', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async () => { throw new Error('execution reverted'); }) };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
  });

  it('returns null when latestRoundData reports a non-positive or clearly invalid answer', async () => {
    const lookupBySymbol = vi.fn(async () => candidateFeed);
    const client = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 8;
      if (functionName === 'latestRoundData') return [1n, 0n, 1n, 1_790_000_000n, 1n];
      throw new Error(`unexpected ${functionName}`);
    }) };
    expect(await discoverAndVerifyFeed(client, lookupBySymbol, quote)).toBeNull();
  });
});
