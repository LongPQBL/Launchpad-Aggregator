import { describe, expect, it } from 'vitest';
import { buildGrid, createBlockLocator } from './tvlBackfill.js';

describe('buildGrid', () => {
  const now = 1_800_000_000 + 1234; // not on a bucket boundary
  it('covers only fully ended buckets, sampled at their last second, sorted by time', () => {
    const grid = buildGrid(now, 400);
    expect(grid.every((point) => point.sampleAt === point.bucketStart + point.interval - 1 && point.sampleAt <= now)).toBe(true);
    expect(grid.every((point, index) => index === 0 || grid[index - 1]!.sampleAt <= point.sampleAt)).toBe(true);
  });
  it('uses the hourly window for 7 days, 4-hour for 30 days and daily for the whole range', () => {
    const grid = buildGrid(now, 100);
    const count = (interval: number) => grid.filter((point) => point.interval === interval).length;
    expect(count(3600)).toBeGreaterThanOrEqual(167);
    expect(count(3600)).toBeLessThanOrEqual(168);
    expect(count(14_400)).toBeGreaterThanOrEqual(179);
    expect(count(14_400)).toBeLessThanOrEqual(180);
    expect(count(86_400)).toBeGreaterThanOrEqual(99);
    expect(count(86_400)).toBeLessThanOrEqual(100);
  });
  it('shrinks every window to the requested number of days', () => {
    expect(buildGrid(now, 2).filter((point) => point.interval === 3600).length).toBeLessThanOrEqual(48);
  });
});

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
