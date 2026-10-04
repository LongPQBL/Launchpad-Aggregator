import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { readExtendedTokenMetadata } from './extendedMetadata.js';

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
