import { describe, expect, it } from 'vitest';
import { nextWeightedSource } from './weightedRoundRobin.js';

describe('nextWeightedSource', () => {
  it('selects sources proportionally to weight using smooth weighted round robin', () => {
    const weights = new Map([['a', 3], ['b', 1]]);
    const current = new Map<string, number>();
    const picks = Array.from({ length: 8 }, () => nextWeightedSource(current, weights, ['a', 'b']));
    // Exact Nginx-style SWRR sequence for weights {a:3, b:1}: period 4, 3:1 ratio, never two b's in a row.
    expect(picks).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it('gives every source at least one turn out of totalWeight attempts, even the lowest-weighted one', () => {
    const weights = new Map([['a', 100], ['b', 1]]);
    const current = new Map<string, number>();
    const picks = Array.from({ length: 101 }, () => nextWeightedSource(current, weights, ['a', 'b']));
    expect(picks).toContain('b');
  });

  it('defaults an unweighted source to weight 1 instead of excluding it', () => {
    const weights = new Map([['a', 5]]);
    const current = new Map<string, number>();
    const picks = Array.from({ length: 6 }, () => nextWeightedSource(current, weights, ['a', 'b']));
    expect(picks).toContain('b');
  });

  it('rejects an empty source list', () => {
    expect(() => nextWeightedSource(new Map(), new Map(), [])).toThrow(/no sources/i);
  });
});
