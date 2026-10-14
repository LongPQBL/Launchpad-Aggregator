import { defineChain } from 'viem';
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
// In the browser the chain is read through this app's /api/rpc (the provider's URL, with its key, stays on the server); on the server, and as the
// URL offered to a wallet when adding the chain, the public RPC is used.
const readUrl = typeof window === 'undefined' ? PUBLIC_RPC : `${window.location.origin}/api/rpc`;

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const walletConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: { [robinhoodChain.id]: http(readUrl) },
});
