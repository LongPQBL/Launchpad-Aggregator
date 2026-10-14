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

// For rankings (volume, FDV, ...): a refresh updates the numbers of rows already on screen but never
// moves them, so the list does not reshuffle under the reader's cursor. Rows the fresh page has that
// are not shown yet are ignored, except when `prependNew` is set (a newest-first list, where a new
// launch belongs at the top): those fresh rows ahead of the first already-shown row are put in front.
export function refreshRowsInPlace<T>(fresh: readonly T[], previous: readonly T[], keyOf: (item: T) => string,
  prependNew = false): readonly T[] {
  const freshByKey = new Map(fresh.map((item) => [keyOf(item), item]));
  const shown = new Set(previous.map(keyOf));
  const updated = previous.map((item) => freshByKey.get(keyOf(item)) ?? item);
  if (!prependNew) return updated;
  const firstKnown = fresh.findIndex((item) => shown.has(keyOf(item)));
  const ahead = firstKnown === -1 ? [] : fresh.slice(0, firstKnown);
  return ahead.length === 0 ? updated : [...ahead, ...updated];
}
