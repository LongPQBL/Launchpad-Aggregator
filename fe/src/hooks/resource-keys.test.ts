import { describe, expect, it } from 'vitest';
import { chainResourceKey, launchResourceKey, matchesResourceKeys } from './resource-keys';

describe('resource keys', () => {
  it('builds distinct keys for a chain and for a specific launch on that chain', () => {
    expect(chainResourceKey(4663)).toBe('chain:4663');
    expect(launchResourceKey(4663, '0xABC')).toBe('launch:4663:0xabc');
    expect(chainResourceKey(4663)).not.toBe(launchResourceKey(4663, '0xabc'));
  });
});

describe('matchesResourceKeys', () => {
  it('matches a chain-scoped subscriber to any event on that chain, including other tokens', () => {
    const otherTokenTrade = { chainId: 4663, tokenAddress: '0xother' };

    expect(matchesResourceKeys(otherTokenTrade, [chainResourceKey(4663)])).toBe(true);
  });

  it('does not match a launch-scoped subscriber to a different token\'s trade on the same chain', () => {
    // A detail page for 0xabc must not refetch every time any other pons token on the chain trades.
    const otherTokenTrade = { chainId: 4663, tokenAddress: '0xother' };

    expect(matchesResourceKeys(otherTokenTrade, [launchResourceKey(4663, '0xabc')])).toBe(false);
  });

  it('matches a launch-scoped subscriber to its own token\'s trade', () => {
    const ownTrade = { chainId: 4663, tokenAddress: '0xabc' };

    expect(matchesResourceKeys(ownTrade, [launchResourceKey(4663, '0xabc')])).toBe(true);
  });

  it('matches a launch-scoped subscriber to a chain-wide event with no tokenAddress (e.g. coverage.changed)', () => {
    const chainWideCoverageEvent = { chainId: 4663 };

    expect(matchesResourceKeys(chainWideCoverageEvent, [launchResourceKey(4663, '0xabc')])).toBe(true);
  });

  it('does not match a subscriber on a different chain', () => {
    const otherChainEvent = { chainId: 1, tokenAddress: '0xabc' };

    expect(matchesResourceKeys(otherChainEvent, [launchResourceKey(4663, '0xabc')])).toBe(false);
  });
});
