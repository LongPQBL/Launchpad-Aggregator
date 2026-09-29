import { describe, expect, it } from 'vitest';
import { chainExplorerBase, chainName } from './chains';

describe('chainName', () => {
  it('names the known Robinhood chain', () => {
    expect(chainName(4663)).toBe('Robinhood Chain');
  });

  it('falls back to a generic label for an unknown chain instead of guessing a name', () => {
    expect(chainName(1)).toBe('Chain 1');
  });
});

describe('chainExplorerBase', () => {
  it('returns the Robinhood chain explorer base URL', () => {
    expect(chainExplorerBase(4663)).toBe('https://robinhoodchain.blockscout.com');
  });

  it('returns undefined for an unknown chain instead of guessing an explorer URL', () => {
    expect(chainExplorerBase(1)).toBeUndefined();
  });
});
