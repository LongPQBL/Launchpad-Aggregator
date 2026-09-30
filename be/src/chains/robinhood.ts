import { createPublicClient, defineChain, http, type HttpTransport, type PublicClient } from 'viem';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export function createRobinhoodPublicClient(httpUrl: string): PublicClient<HttpTransport, typeof robinhood> {
  // Deliberately NOT using viem's client-wide `batch` option: it shares one scheduler across
  // every call this client makes (keyed only by URL), so unrelated concurrent traffic — parallel
  // factory scans, getLogs, per-launch metadata reads — gets merged into the same JSON-RPC batch
  // unpredictably, and this RPC's single-object error response for a rejected batch isn't handled
  // cleanly by viem's batcher (surfaces as a confusing "Cannot read properties of undefined"
  // instead of a retryable 429). indexer/blockDataBatch.ts does its own scoped, explicit batching
  // instead, only for block-data lookups, with error handling scan.ts's retry logic understands.
  return createPublicClient({ chain: robinhood, transport: http(httpUrl) });
}
