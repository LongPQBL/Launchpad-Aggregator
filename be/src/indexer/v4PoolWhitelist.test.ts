import { describe, expect, it } from 'vitest';
import { renderV4PoolWhitelistModule } from './v4PoolWhitelist.js';

describe('renderV4PoolWhitelistModule', () => {
  it('renders a sorted, lowercased, deduplicated TypeScript const array', () => {
    const source = renderV4PoolWhitelistModule(['0xABC123', '0xabc123', '0xZZZ999']);
    expect(source).toContain("'0xabc123'");
    expect(source).toContain("'0xzzz999'");
    expect(source.match(/0xabc123/g)).toHaveLength(1);
  });

  it('never matches a real poolId when given an empty list (safe default, not "no filter")', () => {
    const source = renderV4PoolWhitelistModule([]);
    expect(source).toContain("'0x" + '0'.repeat(64) + "'");
  });

  it('is valid, parseable TypeScript exporting KNOWN_PONS_V4_POOL_IDS', () => {
    const source = renderV4PoolWhitelistModule(['0xabc']);
    expect(source).toMatch(/export const KNOWN_PONS_V4_POOL_IDS: readonly string\[\] = \[/);
  });
});
