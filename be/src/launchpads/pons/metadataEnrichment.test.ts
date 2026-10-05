import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Database } from '../../db/client.js';
import { enrichMetadataSafely, resolveMetadataBatchLimit, startMetadataEnrichmentLoop } from './metadataEnrichment.js';

afterEach(() => vi.useRealTimers());

it('contains a worker failure and logs no RPC URL or credential', async () => {
  const events: unknown[] = [];
  const brokenDb = { $client: { connect: async () => { throw new Error('https://rpc.example/secret-key'); } } } as unknown as Database;
  await expect(enrichMetadataSafely(brokenDb, {} as Pool, {
    readContract: async () => '', getBlock: async () => ({ timestamp: 1n }),
  }, new Date('2026-10-04T00:00:00Z'), (event) => events.push(event))).resolves.toBeUndefined();
  expect(events).toEqual([{ kind: 'enrichment_error' }]);
  expect(JSON.stringify(events)).not.toContain('secret-key');
});

it('runs on its own minute schedule, never overlaps passes, and waits for a pass at shutdown', async () => {
  vi.useFakeTimers();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const run = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
  const loop = startMetadataEnrichmentLoop(run);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(1);
  releaseFirst();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  await loop.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it('uses a ten-launch default and accepts a bounded operator override', () => {
  expect(resolveMetadataBatchLimit(undefined)).toBe(10);
  expect(resolveMetadataBatchLimit('25')).toBe(25);
  expect(() => resolveMetadataBatchLimit('0')).toThrow('Invalid metadata batch limit');
  expect(() => resolveMetadataBatchLimit('101')).toThrow('Invalid metadata batch limit');
});
