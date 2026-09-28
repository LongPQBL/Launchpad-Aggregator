import { createPublicClient, defineChain, http, type HttpTransport, type PublicClient } from 'viem';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export function createRobinhoodPublicClient(httpUrl: string): PublicClient<HttpTransport, typeof robinhood> {
  return createPublicClient({ chain: robinhood, transport: http(httpUrl) });
}
