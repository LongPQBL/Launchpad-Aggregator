import { describe, expect, it } from 'vitest';
import { indexedFromBlockFromEnv } from './envioDb.js';

describe('indexedFromBlockFromEnv', () => {
  it('is null (full history) when unset or empty', () => {
    expect(indexedFromBlockFromEnv({})).toBeNull();
    expect(indexedFromBlockFromEnv({ ENVIO_INDEXED_FROM_BLOCK: '' })).toBeNull();
  });
  it('reads a block number', () => {
    expect(indexedFromBlockFromEnv({ ENVIO_INDEXED_FROM_BLOCK: '88580000' })).toBe(88580000n);
  });
  it('rejects anything that is not a block number', () => {
    expect(() => indexedFromBlockFromEnv({ ENVIO_INDEXED_FROM_BLOCK: '8.8e7' })).toThrow('block number');
  });
});
