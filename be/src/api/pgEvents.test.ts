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
    const poolTokens = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
    expect(parseDatabaseEvent(JSON.stringify({ type: 'pool.changed', chainId: 4663, poolId, poolTokens }))).toEqual({ type: 'pool.changed', chainId: 4663, poolId, poolTokens });
    expect(parseDatabaseEvent(JSON.stringify({ type: 'pool.changed', chainId: 4663, poolId, poolTokens: ['nope'] }))).toBeNull();
  });

  it('carries the block time of an event and rejects a malformed one', () => {
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"tokenAddress":"0x1111111111111111111111111111111111111111","blockTimestamp":1700000000}'))
      .toEqual({ type: 'trade.created', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', blockTimestamp: 1_700_000_000 });
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"blockTimestamp":"soon"}')).toBeNull();
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"blockTimestamp":-5}')).toBeNull();
  });

  it('carries which lane delivered an event and rejects an unknown lane', () => {
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"via":"fast"}')).toEqual({ type: 'trade.created', chainId: 4663, via: 'fast' });
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"via":"carrier-pigeon"}')).toBeNull();
  });

  it('carries a candle refresh request and rejects a malformed one', () => {
    const event = '{"type":"launch.changed","chainId":4663,"tokenAddress":"0x1111111111111111111111111111111111111111","refreshStats":true}';
    expect(parseDatabaseEvent(event)).toEqual({ type: 'launch.changed', chainId: 4663,
      tokenAddress: '0x1111111111111111111111111111111111111111', refreshStats: true });
    expect(parseDatabaseEvent(event.replace('true', '"yes"'))).toBeNull();
  });
});
