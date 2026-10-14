import { describe, expect, it, vi } from 'vitest';
import { robinhoodChain, walletConfig } from './config';

describe('browser wallet configuration', () => {
  it('uses Robinhood Chain mainnet and offers its public RPC to a wallet', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChain.nativeCurrency.symbol).toBe('ETH');
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(walletConfig.chains.map((chain) => chain.id)).toEqual([4663]);
  });

  it('exposes an injected browser connector', () => {
    expect(walletConfig.connectors.some((connector) => connector.type === 'injected')).toBe(true);
  });

  it('never puts a configured RPC URL (which carries an API key) into the browser bundle', async () => {
    vi.stubEnv('NEXT_PUBLIC_RH_HTTP_RPC_URL', 'https://custom.example/rpc-with-key');
    vi.stubEnv('RH_HTTP_RPC_URL', 'https://custom.example/rpc-with-key');
    vi.resetModules();
    try {
      const { robinhoodChain: configured } = await import('./config');
      expect(JSON.stringify(configured.rpcUrls)).not.toContain('custom.example');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
