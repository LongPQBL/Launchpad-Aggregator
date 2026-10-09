import { describe, expect, it } from 'vitest';
import { assertClientMatchesChain, getChainConfig, isSupportedChain, rpcUrlFor } from './registry.js';

describe('chain registry', () => {
  it('knows Robinhood Chain and nothing else yet', () => {
    expect(isSupportedChain(4663)).toBe(true);
    expect(isSupportedChain(1)).toBe(false);
    expect(getChainConfig(4663)).toMatchObject({ name: 'Robinhood Chain', nativeSymbol: 'ETH' });
  });

  it('takes the RPC URL from the chain\'s environment variable, falling back to the default', () => {
    const chain = getChainConfig(4663)!;
    expect(rpcUrlFor(chain, { RH_HTTP_RPC_URL: 'https://private.example' })).toBe('https://private.example');
    expect(rpcUrlFor(chain, {})).toBe(chain.defaultRpcUrl);
  });

  it('rejects a client that belongs to another chain, and accepts one that declares no chain', () => {
    expect(() => assertClientMatchesChain({ chain: { id: 1 } }, 4663)).toThrow('chain 1, not chain 4663');
    expect(() => assertClientMatchesChain({ chain: { id: 4663 } }, 4663)).not.toThrow();
    expect(() => assertClientMatchesChain({}, 4663)).not.toThrow();
  });
});
