import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { createTokenMetadataResolver } from './tokenMetadata.js';

const nvda = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';

describe('token metadata resolver', () => {
  it('returns the static ETH entry for the zero address without any RPC or registry call', async () => {
    const readContract = vi.fn();
    const resolveMetadata = vi.fn();
    const resolver = createTokenMetadataResolver({ readContract }, { resolveMetadata });

    expect(await resolver.resolve(zeroAddress)).toEqual({ symbol: 'ETH', name: 'Ether', logoUri: null });
    expect(readContract).not.toHaveBeenCalled();
    expect(resolveMetadata).not.toHaveBeenCalled();
  });

  it('combines on-chain name/symbol with the asset registry logo for an unknown token', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'name' ? 'NVIDIA • Robinhood Token' : 'NVDA');
    const resolveMetadata = vi.fn(async () => ({
      name: 'NVIDIA • Robinhood Token',
      logoUri: 'https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png',
    }));
    const resolver = createTokenMetadataResolver({ readContract }, { resolveMetadata });

    expect(await resolver.resolve(nvda)).toEqual({
      symbol: 'NVDA', name: 'NVIDIA • Robinhood Token',
      logoUri: 'https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png',
    });
  });

  it('falls back to null fields, never throwing, when both the RPC call and the registry fail', async () => {
    const readContract = vi.fn(async () => { throw new Error('revert'); });
    const resolveMetadata = vi.fn(async () => { throw new Error('registry unavailable'); });
    const resolver = createTokenMetadataResolver({ readContract }, { resolveMetadata });

    expect(await resolver.resolve(nvda)).toEqual({ symbol: null, name: null, logoUri: null });
  });

  it('falls back to the asset registry name when on-chain name() is unavailable', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'name' ? Promise.reject(new Error('revert')) : 'NVDA');
    const resolveMetadata = vi.fn(async () => ({ name: 'NVIDIA • Robinhood Token', logoUri: null }));
    const resolver = createTokenMetadataResolver({ readContract }, { resolveMetadata });

    expect(await resolver.resolve(nvda)).toEqual({ symbol: 'NVDA', name: 'NVIDIA • Robinhood Token', logoUri: null });
  });

  it('caches a resolved address so a second resolve does not call the RPC client or registry again', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'name' ? 'NVIDIA • Robinhood Token' : 'NVDA');
    const resolveMetadata = vi.fn(async () => ({ name: null, logoUri: null }));
    const resolver = createTokenMetadataResolver({ readContract }, { resolveMetadata });

    await resolver.resolve(nvda);
    await resolver.resolve(nvda.toUpperCase());
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(resolveMetadata).toHaveBeenCalledTimes(1);
  });
});
