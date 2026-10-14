import { describe, expect, it } from 'vitest';
import { parseDatabaseEvent } from './pgEvents.js';

describe('database event bridge', () => {
  it('accepts only compact resource keys and known event names', () => {
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"tokenAddress":"0x1111111111111111111111111111111111111111"}'))
      .toEqual({ type: 'trade.created', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
    expect(parseDatabaseEvent('{"type":"raw.log","chainId":4663}')).toBeNull();
    expect(parseDatabaseEvent('invalid')).toBeNull();
  });

  it('carries the pool of a pool.changed event and rejects a malformed pool id', () => {
    const poolId = `0x${'ab'.repeat(32)}`;
    expect(parseDatabaseEvent(JSON.stringify({ type: 'pool.changed', chainId: 4663, poolId }))).toEqual({ type: 'pool.changed', chainId: 4663, poolId });
    expect(parseDatabaseEvent(JSON.stringify({ type: 'pool.changed', chainId: 4663, poolId: '0x12' }))).toBeNull();
  });
});
