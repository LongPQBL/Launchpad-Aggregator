import { describe, expect, it, vi } from 'vitest';
import { robinhoodChain, walletConfig } from './config';

describe('browser wallet configuration', () => {
  it('uses Robinhood Chain mainnet and the configured RPC', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChain.nativeCurrency.symbol).toBe('ETH');
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe(process.env.NEXT_PUBLIC_RH_HTTP_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
    expect(walletConfig.chains.map((chain) => chain.id)).toEqual([4663]);
  });

  it('exposes an injected browser connector', () => {
    expect(walletConfig.connectors.some((connector) => connector.type === 'injected')).toBe(true);
  });

  it('uses a configured RPC endpoint for browser reads', async () => {
    vi.stubEnv('NEXT_PUBLIC_RH_HTTP_RPC_URL', 'https://custom.example/rpc');
    vi.resetModules();
    try {
      const { robinhoodChain: configured } = await import('./config');
      expect(configured.rpcUrls.default.http[0]).toBe('https://custom.example/rpc');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
