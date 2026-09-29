import { describe, expect, it } from 'vitest';
import { selectIndexerSourceIds } from './sourceSelection.js';

describe('indexer source selection', () => {
  it('allows an operator to run only v2 sources without marking v1 as complete', () => {
    const configured = ['pons-v1-legacy', 'pons-v1-active', 'pons-v2', 'pons-v1-legacy-trades', 'pons-v1-active-trades', 'pons-v2-curve'];
    expect(selectIndexerSourceIds(configured, 'pons-v2,pons-v2-curve')).toEqual(['pons-v2', 'pons-v2-curve']);
    expect(selectIndexerSourceIds(configured, undefined)).toEqual(configured);
    expect(() => selectIndexerSourceIds(configured, 'unknown')).toThrow(/unknown/i);
  });
});
