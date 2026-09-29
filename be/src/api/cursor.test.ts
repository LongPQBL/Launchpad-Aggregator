import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('API cursor', () => {
  it('round-trips an exact block, transaction hash and log index', () => {
    const value = { blockNumber: 999999999999999999n, txHash: `0x${'a'.repeat(64)}`, logIndex: 42 };
    expect(decodeCursor(encodeCursor(value))).toEqual(value);
  });

  it('rejects malformed cursors instead of silently restarting the page', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(/cursor/i);
    expect(() => decodeCursor(Buffer.from(JSON.stringify(['1', 'oops', 0])).toString('base64url'))).toThrow(/cursor/i);
  });
});
