import { describe, expect, it } from 'vitest';
import { mergeRefreshedPage } from './merge-refreshed-page';

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
