// Names for the roadmap filter; only Robinhood has an integrated launch source and explorer here.
const CHAIN_NAMES: Record<number, string> = {
  4663: 'Robinhood Chain',
  8453: 'Base',
  42161: 'Arbitrum',
  5042: 'Arc',
  4326: 'MegaETH',
  143: 'Monad',
  1155: 'Intuition',
  988: 'Stable',
  4200: 'Merlin',
  56: 'BNB Smart Chain',
};
const CHAIN_EXPLORERS: Record<number, string> = { 4663: 'https://robinhoodchain.blockscout.com' };
const CHAIN_ICONS: Record<number, string> = {
  4663: '/images/chains/robinhood-chain.png',
  8453: '/images/chains/base.png',
  42161: '/images/chains/arbitrum.png',
  5042: '/images/chains/arc.jpeg',
  4326: '/images/chains/megaeth.webp',
  143: '/images/chains/monad.png',
  1155: '/images/chains/intuition.jpg',
  988: '/images/chains/stable.png',
  4200: '/images/chains/merlin.webp',
  56: '/images/chains/bnb-smart-chain.png',
};

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function chainIcon(chainId: number): string | undefined {
  return CHAIN_ICONS[chainId];
}

export function chainExplorerBase(chainId: number): string | undefined {
  return CHAIN_EXPLORERS[chainId];
}
