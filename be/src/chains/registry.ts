import { robinhood } from './robinhood.js';

// The single list of chains the backend knows about. Code that needs "is this chain supported", a chain's name,
// or which environment variable holds its RPC URL reads it from here instead of comparing against a literal
// chain id. Adding a chain = add an entry here (plus its viem chain definition, source registry and Envio
// config — see "Adding a chain or a launchpad" in CLAUDE.md).
export interface ChainConfig {
  id: number;
  name: string;
  nativeSymbol: string;
  /** Environment variable holding this chain's HTTP RPC URL; falls back to `defaultRpcUrl`. */
  rpcUrlEnvVar: string;
  defaultRpcUrl: string;
  explorerBaseUrl: string | null;
}

export const CHAIN_CONFIGS: readonly ChainConfig[] = [
  {
    id: robinhood.id,
    name: robinhood.name,
    nativeSymbol: robinhood.nativeCurrency.symbol,
    rpcUrlEnvVar: 'RH_HTTP_RPC_URL',
    defaultRpcUrl: robinhood.rpcUrls.default.http[0],
    explorerBaseUrl: robinhood.blockExplorers.default.url,
  },
];

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return CHAIN_CONFIGS.find((chain) => chain.id === chainId);
}

export function isSupportedChain(chainId: number): boolean {
  return getChainConfig(chainId) !== undefined;
}

export function rpcUrlFor(chain: ChainConfig, env: Record<string, string | undefined>): string {
  return env[chain.rpcUrlEnvVar] || chain.defaultRpcUrl;
}

/**
 * A viem client knows which chain it talks to. Reading chain A's contracts through chain B's client returns a
 * plausible-looking wrong answer rather than an error, so every chain-scoped read checks this first. Clients
 * that do not declare a chain (test doubles) are accepted.
 */
export function assertClientMatchesChain(client: { chain?: { id: number } | undefined }, chainId: number): void {
  if (client.chain !== undefined && client.chain.id !== chainId) {
    throw new Error(`RPC client is for chain ${client.chain.id}, not chain ${chainId}`);
  }
}
