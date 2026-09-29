// Bounds how many per-item RPC lookups (block timestamps, per-launch metadata reads) run at
// once per decode batch. Kept modest (rather than e.g. 25+) because this RPC's rate limit is
// tight enough that a large burst can trip it on its own — scan.ts now waits out a reported
// reset window when that happens, but it is still cheaper to avoid tripping it in the first place.
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
