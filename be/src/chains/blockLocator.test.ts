import { describe, expect, it } from 'vitest';
import { createBlockLocator } from './blockLocator.js';

describe('createBlockLocator', () => {
  // Block n has timestamp 1000 + 2n; the head is block 1,000,000.
  const calls = { blocks: 0 };
  const client = {
    getBlockNumber: async () => 1_000_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { calls.blocks += 1; return { timestamp: BigInt(1000 + 2 * Number(blockNumber)) }; },
  };
  it('finds the latest block at or before the target time without scanning', async () => {
    const locate = createBlockLocator(client);
    expect(await locate(1000 + 2 * 250_000 + 1)).toEqual({ block: 250_000n, timestamp: 501_000 });
    expect(calls.blocks).toBeLessThan(45);
  });
  it('returns the head when the target is in the future and null before the chain began', async () => {
    const locate = createBlockLocator(client);
    expect((await locate(9_999_999_999))?.block).toBe(1_000_000n);
    expect(await locate(5)).toBeNull();
  });
});
