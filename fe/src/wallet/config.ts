import { defineChain } from 'viem';
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const walletConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: { [robinhoodChain.id]: http(robinhoodChain.rpcUrls.default.http[0]) },
});
