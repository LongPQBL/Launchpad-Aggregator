import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import { logKey, tokenKey, venueKey } from './ids.js';

const token = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address;
const blockHash = `0x${'1'.repeat(64)}` as Hash;
const txHash = `0x${'2'.repeat(64)}` as Hash;

describe('chain-scoped identities', () => {
  it('does not merge the same token address across chains', () => {
    expect(tokenKey(4663, token)).not.toBe(tokenKey(56, token));
  });

  it('normalizes address casing on the same chain', () => {
    expect(tokenKey(4663, token)).toBe(tokenKey(4663, token.toLowerCase() as Address));
  });

  it('does not merge venue kinds with the same reference', () => {
    expect(venueKey(4663, 'v3_pool', token)).not.toBe(venueKey(4663, 'v4_pool', token));
  });

  it('keeps different block hashes for a reorged log', () => {
    expect(logKey(4663, blockHash, txHash, 0)).not.toBe(
      logKey(4663, `0x${'3'.repeat(64)}` as Hash, txHash, 0),
    );
  });
});
