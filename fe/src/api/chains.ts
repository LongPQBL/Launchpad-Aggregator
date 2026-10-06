// Only chain known/verified in be/src/chains today (README, be/src/chains/robinhood.ts).
// A chain-registry that scales beyond this hardcode is a Roadmap-2 concern, not this task's.
const CHAIN_NAMES: Record<number, string> = { 4663: 'Robinhood Chain' };
const CHAIN_EXPLORERS: Record<number, string> = { 4663: 'https://robinhoodchain.blockscout.com' };
const CHAIN_ICONS: Record<number, string> = { 4663: '/images/chains/robinhood-chain.png' };

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function chainIcon(chainId: number): string | undefined {
  return CHAIN_ICONS[chainId];
}

export function chainExplorerBase(chainId: number): string | undefined {
  return CHAIN_EXPLORERS[chainId];
}
