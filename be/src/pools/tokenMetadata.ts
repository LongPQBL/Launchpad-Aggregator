import { parseAbi, zeroAddress, type Address } from 'viem';
import type { UsdPriceClient } from '../market/usdPricing.js';

export interface TokenMetadata { symbol: string | null; name: string | null; logoUri: string | null }

export interface AssetMetadataRegistry {
  resolveMetadata(address: string): Promise<{ name: string | null; logoUri: string | null } | null>;
}

const erc20MetadataAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);

// Quote/pool-currency tokens are not Pons-minted, so unlike a launch token they never have a
// custom `logo()` function (be/src/launchpads/pons/extendedMetadata.ts) — name/symbol come from
// the standard ERC20 read any token supports, logo has no on-chain source at all and can only come
// from the Robinhood asset directory (AssetMetadataRegistry, already fetched for USD-feed lookup).
// A resolved address's metadata is immutable for the process lifetime (an ERC20's name/symbol
// never change), so this is a plain never-expiring cache, not a TTL/lease system like Pons token
// metadata enrichment — there is no unbounded or fast-growing set of addresses to page through.
const STATIC: Readonly<Record<string, TokenMetadata>> = {
  [zeroAddress]: { symbol: 'ETH', name: 'Ether', logoUri: null },
};

export function createTokenMetadataResolver(rpcClient: UsdPriceClient, assetRegistry: AssetMetadataRegistry):
{ resolve(address: string): Promise<TokenMetadata> } {
  const cache = new Map<string, Promise<TokenMetadata>>();

  async function resolveUncached(address: Address): Promise<TokenMetadata> {
    const [name, symbol, asset] = await Promise.all([
      rpcClient.readContract({ address, abi: erc20MetadataAbi, functionName: 'name' }).catch(() => null),
      rpcClient.readContract({ address, abi: erc20MetadataAbi, functionName: 'symbol' }).catch(() => null),
      assetRegistry.resolveMetadata(address).catch(() => null),
    ]);
    return {
      name: typeof name === 'string' && name ? name : (asset?.name ?? null),
      symbol: typeof symbol === 'string' && symbol ? symbol : null,
      logoUri: asset?.logoUri ?? null,
    };
  }

  return {
    resolve(address: string): Promise<TokenMetadata> {
      const lower = address.toLowerCase();
      const known = STATIC[lower];
      if (known) return Promise.resolve(known);
      let pending = cache.get(lower);
      if (!pending) {
        pending = resolveUncached(address as Address);
        cache.set(lower, pending);
      }
      return pending;
    },
  };
}
