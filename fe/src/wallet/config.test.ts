import { describe, expect, it } from 'vitest';
import { robinhoodChain, walletConfig } from './config';

describe('browser wallet configuration', () => {
  it('uses Robinhood Chain mainnet and its public RPC', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChain.nativeCurrency.symbol).toBe('ETH');
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(walletConfig.chains.map((chain) => chain.id)).toEqual([4663]);
  });

  it('exposes an injected browser connector', () => {
    expect(walletConfig.connectors.some((connector) => connector.type === 'injected')).toBe(true);
  });
});
