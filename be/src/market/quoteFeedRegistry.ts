import type { Address } from 'viem';

const ASSETS_URL = 'https://api.robinhood.com/rhj/assets';
const FEEDS_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface Asset { tokenSymbol?: unknown; tokenName?: unknown; logoUrl?: unknown; status?: unknown;
  deployments?: { chainId?: unknown; contractAddress?: unknown }[] }
interface Feed { name?: unknown; proxyAddress?: unknown }
export interface RobinhoodAssetMetadata { name: string | null; logoUri: string | null }

function feedSymbol(name: string): string | null {
  // Tokenized-stock feeds are named "Robinhood SYMBOL / USD" or "Robinhood SYMBOL-USD"; crypto
  // quote feeds (ETH, USDG, ...) use the same "SYMBOL / USD" suffix without that prefix.
  const match = /^(?:Robinhood )?([A-Z0-9]+)(?: \/ USD|-USD)$/i.exec(name);
  return match?.[1]?.toUpperCase() ?? null;
}

export function createQuoteFeedRegistry(fetchJson: (url: string) => Promise<unknown>, now: () => number = Date.now):
{ resolve(address: string): Promise<Address | null>; resolveMetadata(address: string): Promise<RobinhoodAssetMetadata | null> } {
  let feeds = new Map<string, Address>();
  let metadata = new Map<string, RobinhoodAssetMetadata>();
  let expiresAt = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const [assetsResponse, feedsResponse] = await Promise.all([fetchJson(ASSETS_URL), fetchJson(FEEDS_URL)]);
    if (!assetsResponse || typeof assetsResponse !== 'object' || !('assets' in assetsResponse)
      || !Array.isArray(assetsResponse.assets) || !Array.isArray(feedsResponse)) throw new Error('Invalid quote feed registry response');
    const bySymbol = new Map<string, Address | null>();
    for (const raw of feedsResponse as Feed[]) {
      if (typeof raw.name !== 'string' || typeof raw.proxyAddress !== 'string' || !ADDRESS.test(raw.proxyAddress)) continue;
      const symbol = feedSymbol(raw.name);
      if (!symbol) continue;
      bySymbol.set(symbol, bySymbol.has(symbol) ? null : raw.proxyAddress as Address);
    }
    const nextFeeds = new Map<string, Address>();
    const nextMetadata = new Map<string, RobinhoodAssetMetadata>();
    for (const asset of assetsResponse.assets as Asset[]) {
      if (asset.status !== 'ASSET_STATUS_ACTIVE' || typeof asset.tokenSymbol !== 'string' || !Array.isArray(asset.deployments)) continue;
      const feed = bySymbol.get(asset.tokenSymbol.toUpperCase());
      const assetMetadata: RobinhoodAssetMetadata = {
        name: typeof asset.tokenName === 'string' ? asset.tokenName : null,
        logoUri: typeof asset.logoUrl === 'string' ? asset.logoUrl : null,
      };
      for (const deployment of asset.deployments) {
        if (deployment.chainId === 4663 && typeof deployment.contractAddress === 'string' && ADDRESS.test(deployment.contractAddress)) {
          const key = deployment.contractAddress.toLowerCase();
          if (feed) nextFeeds.set(key, feed);
          nextMetadata.set(key, assetMetadata);
        }
      }
    }
    feeds = nextFeeds;
    metadata = nextMetadata;
    expiresAt = now() + REFRESH_MS;
  }

  return {
    async resolve(address: string): Promise<Address | null> {
      if (!ADDRESS.test(address)) return null;
      if (now() >= expiresAt) {
        inFlight ??= refresh().finally(() => { inFlight = null; });
        try { await inFlight; } catch {
          expiresAt = now() + RETRY_MS;
          return feeds.get(address.toLowerCase()) ?? null;
        }
      }
      return feeds.get(address.toLowerCase()) ?? null;
    },
    async resolveMetadata(address: string): Promise<RobinhoodAssetMetadata | null> {
      if (!ADDRESS.test(address)) return null;
      if (now() >= expiresAt) {
        inFlight ??= refresh().finally(() => { inFlight = null; });
        try { await inFlight; } catch {
          expiresAt = now() + RETRY_MS;
          return metadata.get(address.toLowerCase()) ?? null;
        }
      }
      return metadata.get(address.toLowerCase()) ?? null;
    },
  };
}

export const quoteFeedRegistry = createQuoteFeedRegistry(async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Quote registry request failed: ${response.status}`);
  return response.json();
});
