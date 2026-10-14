import { describe, expect, it } from 'vitest';
import { mergeRefreshedPage, refreshRowsInPlace } from './merge-refreshed-page';

const key = (n: number) => String(n);

describe('mergeRefreshedPage', () => {
  it('keeps already-loaded older pages and their cursor when the fresh first page overlaps them', () => {
    const merged = mergeRefreshedPage([5, 4, 3], 'fresh', [4, 3, 2, 1], 'old', (n) => key(n));
    expect(merged).toEqual({ items: [5, 4, 3, 2, 1], nextCursor: 'old' });
  });

  it('uses the fresh cursor when nothing beyond the first page was loaded', () => {
    expect(mergeRefreshedPage([3, 2], 'fresh', [3, 2], 'stale', (n) => key(n))).toEqual({ items: [3, 2], nextCursor: 'fresh' });
  });
});

describe('refreshRowsInPlace', () => {
  const k = (item: { id: string }) => item.id;
  const row = (id: string, v: number) => ({ id, v });

  it('updates the numbers of shown rows without moving them, even when the fresh ranking differs', () => {
    const shown = [row('a', 1), row('b', 2), row('c', 3)];
    const fresh = [row('c', 30), row('a', 10), row('b', 20)];
    expect(refreshRowsInPlace(fresh, shown, k)).toEqual([row('a', 10), row('b', 20), row('c', 30)]);
  });

  it('ignores fresh rows that are not shown, and keeps shown rows the fresh page no longer has', () => {
    expect(refreshRowsInPlace([row('z', 9), row('a', 5)], [row('a', 1), row('b', 2)], k)).toEqual([row('a', 5), row('b', 2)]);
  });

  it('puts new rows ahead of the first shown row at the top when the list is newest-first', () => {
    const fresh = [row('n2', 1), row('n1', 1), row('a', 5), row('b', 6)];
    expect(refreshRowsInPlace(fresh, [row('a', 1), row('b', 2)], k, true)).toEqual([row('n2', 1), row('n1', 1), row('a', 5), row('b', 6)]);
  });

  it('appends rows that are not shown yet when asked, without moving shown ones', () => {
    expect(refreshRowsInPlace([row('z', 9), row('a', 5)], [row('a', 1), row('b', 2)], k, false, true)).toEqual([row('a', 5), row('b', 2), row('z', 9)]);
  });
});
