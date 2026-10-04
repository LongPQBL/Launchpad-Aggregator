import { describe, expect, it } from 'vitest';
import { decodeVolumeCursor, encodeVolumeCursor, type VolumeCursorValue } from './volumeCursor.js';

const secret = 'test-secret-do-not-use-in-production';
const value: VolumeCursorValue = { version: 1, sort: 'volume24hUsd', asOf: 1_790_000_000, rankCategory: 'positive',
  rankValue: '1234.56', tiebreakBlockNumber: '100', tiebreakTxHash: '0x' + 'a'.repeat(64), tiebreakLogIndex: 3 };

describe('volumeCursor', () => {
  it('round-trips a value', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(decodeVolumeCursor(encoded, secret, 1_790_000_100)).toEqual(value);
  });

  it('rejects a cursor signed with a different secret (tamper detection)', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(() => decodeVolumeCursor(encoded, 'wrong-secret', 1_790_000_100)).toThrow('Invalid cursor');
  });

  it('rejects a cursor whose payload was edited after signing', () => {
    const encoded = encodeVolumeCursor(value, secret);
    const [payload, signature] = encoded.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...value, rankValue: '999999.99' })).toString('base64url') + '.' + signature;
    expect(() => decodeVolumeCursor(tampered, secret, 1_790_000_100)).toThrow('Invalid cursor');
    void payload;
  });

  it('rejects a cursor older than a bounded age', () => {
    const encoded = encodeVolumeCursor(value, secret);
    expect(() => decodeVolumeCursor(encoded, secret, value.asOf + 25 * 3600)).toThrow('Invalid cursor');
  });

  it('rejects malformed input instead of throwing an unrelated error', () => {
    expect(() => decodeVolumeCursor('not-a-real-cursor', secret, 1_790_000_100)).toThrow('Invalid cursor');
  });
});
