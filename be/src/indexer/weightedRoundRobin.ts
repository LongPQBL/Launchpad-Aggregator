// Smooth Weighted Round Robin (the same algorithm Nginx uses for weighted upstream load balancing):
// each candidate accumulates its own weight every call; the one with the highest running total is
// picked and then docked the sum of all weights. This spreads picks evenly across time in proportion
// to weight (no bursts of the same heavy source back-to-back) while still visiting every candidate,
// including weight-1 ones, at least once per totalWeight calls.
export function nextWeightedSource(current: Map<string, number>, weights: ReadonlyMap<string, number>,
  sourceIds: readonly string[]): string {
  if (sourceIds.length === 0) throw new Error('No sources to select from');
  let totalWeight = 0;
  let best: string | null = null;
  let bestCurrent = -Infinity;
  for (const id of sourceIds) {
    const weight = weights.get(id) ?? 1;
    totalWeight += weight;
    const next = (current.get(id) ?? 0) + weight;
    current.set(id, next);
    if (next > bestCurrent) { bestCurrent = next; best = id; }
  }
  current.set(best!, (current.get(best!) ?? 0) - totalWeight);
  return best!;
}
