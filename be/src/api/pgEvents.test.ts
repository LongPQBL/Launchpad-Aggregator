import { describe, expect, it } from 'vitest';
import { parseDatabaseEvent } from './pgEvents.js';

describe('database event bridge', () => {
  it('accepts only compact resource keys and known event names', () => {
    expect(parseDatabaseEvent('{"type":"trade.created","chainId":4663,"tokenAddress":"0x1111111111111111111111111111111111111111"}'))
      .toEqual({ type: 'trade.created', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
    expect(parseDatabaseEvent('{"type":"raw.log","chainId":4663}')).toBeNull();
    expect(parseDatabaseEvent('invalid')).toBeNull();
  });
});
