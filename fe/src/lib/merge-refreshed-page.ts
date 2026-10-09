// A server refresh (router.refresh from the live-update hook) hands a list component a fresh first
// page. Replacing everything with it would throw away pages the user already scrolled to load, and
// jump them back to the top on every realtime event. Keep the fresh page as the head and append the
// previously loaded rows it doesn't already contain; the cursor continues from the old tail.
export function mergeRefreshedPage<T>(fresh: readonly T[], freshCursor: string | null, previous: readonly T[],
  previousCursor: string | null, keyOf: (item: T) => string): { items: readonly T[]; nextCursor: string | null } {
  const freshKeys = new Set(fresh.map(keyOf));
  const tail = previous.filter((item) => !freshKeys.has(keyOf(item)));
  if (tail.length === 0) return { items: fresh, nextCursor: freshCursor };
  return { items: [...fresh, ...tail], nextCursor: previousCursor };
}
