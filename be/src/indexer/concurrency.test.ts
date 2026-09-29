import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in the result regardless of resolution order', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` calls at once', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('starts work concurrently instead of awaiting each item before starting the next', async () => {
    const started: number[] = [];
    const releases = new Map<number, () => void>();
    const promise = mapWithConcurrency([1, 2, 3], 3, (n) => {
      started.push(n);
      return new Promise<number>((resolve) => { releases.set(n, () => resolve(n)); });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 2, 3]);
    for (const release of releases.values()) release();
    await promise;
  });

  it('propagates a rejection from any item', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });
});
