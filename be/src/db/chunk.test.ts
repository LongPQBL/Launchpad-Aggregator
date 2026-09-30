import { describe, expect, it } from 'vitest';
import { chunkForInsert } from './chunk.js';

describe('chunkForInsert', () => {
  it('keeps a small batch in a single chunk', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);
    expect(chunkForInsert(rows, 18)).toEqual([rows]);
  });

  it('splits a batch that would exceed 65,535 bound parameters into multiple chunks', () => {
    const rows = Array.from({ length: 3_641 }, (_, i) => i);
    const chunks = chunkForInsert(rows, 18);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length * 18 <= 65_535)).toBe(true);
    expect(chunks.flat()).toEqual(rows);
  });

  it('never drops or reorders rows across chunk boundaries', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => i);
    expect(chunkForInsert(rows, 18).flat()).toEqual(rows);
  });

  it('rejects an invalid column count', () => {
    expect(() => chunkForInsert([1], 0)).toThrow('Invalid column count');
  });

  it('returns no chunks for an empty batch', () => {
    expect(chunkForInsert([], 18)).toEqual([]);
  });
});
