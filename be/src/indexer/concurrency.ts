// Bounds how many per-item RPC lookups (per-launch metadata reads) run at once per decode batch.
// Kept modest because a large burst of separate calls can trip this RPC's rate limit on its own.
// Trade block-data lookups (timestamp + traders) don't use this — they go through the explicit
// JSON-RPC batching in indexer/blockDataBatch.ts instead of per-item concurrent calls.
export const RPC_FETCH_CONCURRENCY = 5;

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
