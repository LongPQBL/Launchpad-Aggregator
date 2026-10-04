import { describe, expect, it, vi } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, TimeoutError, type Address } from 'viem';
import { ponsExtendedMetadataAbi, readExtendedTokenMetadata, readExtendedTokenMetadataOutcomes, readLaunchTimestamp } from './extendedMetadata.js';

const TOKEN = '0xadd59906506bf2149212421e9d23db399f588efe' as Address;

describe('readExtendedTokenMetadata', () => {
  it('reads logo/description/socials and maps the socials tuple to the right fields', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') return 'ipfs://bafkreidqqf3trgvnsqj2xccqx3ozaign3at36jbqteb6uskpltjwybfdku';
      if (functionName === 'description') return 'Air-gapped AI inside your building.';
      // [twitter, telegram, discord, website, farcaster] — verified order against a real token this session
      if (functionName === 'socials') return ['https://x.com/garnet_grid', '', '', 'https://garnet.example', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({
      logoUri: 'ipfs://bafkreidqqf3trgvnsqj2xccqx3ozaign3at36jbqteb6uskpltjwybfdku',
      description: 'Air-gapped AI inside your building.',
      websiteUrl: 'https://garnet.example',
      twitterUrl: 'https://x.com/garnet_grid',
    });
  });

  it('treats an empty-string social/description as null, not an empty pill', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') return 'ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu';
      if (functionName === 'description') return '';
      if (functionName === 'socials') return ['', '', '', '', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({
      logoUri: 'ipfs://bafkreigp5feyxvdwyrzlzw3i3rcfrzgtxriswboc34j26tsf6wkvmeoqcu',
      description: null,
      websiteUrl: null,
      twitterUrl: null,
    });
  });

  it('degrades every field to null, without throwing, when the contract does not implement these functions', async () => {
    const readContract = vi.fn(async () => { throw new Error('execution reverted'); });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({ logoUri: null, description: null, websiteUrl: null, twitterUrl: null });
  });

  it('degrades only the failing field to null when one of the three calls reverts and the others succeed', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') throw new Error('execution reverted');
      if (functionName === 'description') return 'Real description';
      if (functionName === 'socials') return ['https://x.com/real', '', '', '', ''];
      throw new Error(`unexpected ${functionName}`);
    });
    const result = await readExtendedTokenMetadata({ readContract }, TOKEN);
    expect(result).toEqual({ logoUri: null, description: 'Real description', websiteUrl: null, twitterUrl: 'https://x.com/real' });
  });
});

describe('retryable extended metadata outcomes', () => {
  const contractError = (cause: Error, functionName: string) => new ContractFunctionExecutionError(cause as HttpRequestError, {
    abi: ponsExtendedMetadataAbi, functionName, contractAddress: TOKEN,
  });

  it('marks empty successful strings and socials as done without inventing values', async () => {
    const result = await readExtendedTokenMetadataOutcomes({ readContract: async ({ functionName }) =>
      functionName === 'socials' ? ['', '', '', '', ''] : '' }, TOKEN);
    expect(result.logo).toEqual({ state: 'done', value: null });
    expect(result.description).toEqual({ state: 'done', value: null });
    expect(result.socials).toEqual({ state: 'done', value: { twitterUrl: null, websiteUrl: null } });
  });

  it('finishes typed contract failures for only the affected functions', async () => {
    const readContract = async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') throw contractError(new ContractFunctionRevertedError({ abi: ponsExtendedMetadataAbi, functionName }), functionName);
      if (functionName === 'description') throw contractError(new ContractFunctionZeroDataError({ functionName }), functionName);
      return ['https://x.com/real', '', '', 'https://real.example', ''];
    };
    const result = await readExtendedTokenMetadataOutcomes({ readContract }, TOKEN);
    expect(result.logo).toEqual({ state: 'done', value: null });
    expect(result.description).toEqual({ state: 'done', value: null });
    expect(result.socials).toEqual({ state: 'done', value: { twitterUrl: 'https://x.com/real', websiteUrl: 'https://real.example' } });
  });

  it('retries wrapped HTTP rate limits and timeouts, including when one other field succeeds', async () => {
    const readContract = async ({ functionName }: { functionName: string }) => {
      if (functionName === 'logo') throw contractError(new HttpRequestError({ url: 'https://rpc.example/key', status: 429 }), functionName);
      if (functionName === 'socials') throw contractError(new TimeoutError({ body: {}, url: 'https://rpc.example/key' }), functionName);
      return 'Saved description';
    };
    const result = await readExtendedTokenMetadataOutcomes({ readContract }, TOKEN);
    expect(result.logo).toEqual({ state: 'pending', value: null, errorKind: 'transport' });
    expect(result.description).toEqual({ state: 'done', value: 'Saved description' });
    expect(result.socials).toEqual({ state: 'pending', value: null, errorKind: 'transport' });
  });

  it('retries unknown errors rather than assuming the function is unsupported', async () => {
    const result = await readExtendedTokenMetadataOutcomes({ readContract: async () => { throw new Error('unknown RPC fault'); } }, TOKEN);
    expect(result.logo).toEqual({ state: 'pending', value: null, errorKind: 'unknown' });
  });

  it('retries a failed timestamp read and retains a successful timestamp', async () => {
    const timeout = new TimeoutError({ body: {}, url: 'https://rpc.example/key' });
    expect(await readLaunchTimestamp({ getBlock: async () => { throw timeout; } }, 123n))
      .toEqual({ state: 'pending', value: null, errorKind: 'transport' });
    expect(await readLaunchTimestamp({ getBlock: async () => ({ timestamp: 1_700_000_000n }) }, 123n))
      .toEqual({ state: 'done', value: 1_700_000_000 });
  });
});
