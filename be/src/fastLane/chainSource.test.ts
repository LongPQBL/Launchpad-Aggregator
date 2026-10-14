import { describe, expect, it } from 'vitest';
import { HTTP_TRANSPORT_OPTIONS, toFastLog, WEBSOCKET_TRANSPORT_OPTIONS } from './chainSource.js';

const base = {
  address: '0xAbC0000000000000000000000000000000000001', topics: [`0x${'11'.repeat(32)}`], data: '0x',
  blockNumber: 12n, blockHash: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, logIndex: 4, removed: false,
} as never;

describe('toFastLog', () => {
  it('maps a viem log and keeps the removed flag', () => {
    expect(toFastLog(base)).toEqual({ address: '0xAbC0000000000000000000000000000000000001', topics: [`0x${'11'.repeat(32)}`], data: '0x',
      blockNumber: 12n, blockHash: `0x${'22'.repeat(32)}`, transactionHash: `0x${'33'.repeat(32)}`, logIndex: 4, removed: false });
    expect(toFastLog({ ...(base as object), removed: true } as never)?.removed).toBe(true);
  });
  it('drops a log that is not mined yet (null block, hash or index)', () => {
    expect(toFastLog({ ...(base as object), blockNumber: null } as never)).toBeNull();
    expect(toFastLog({ ...(base as object), blockHash: null } as never)).toBeNull();
    expect(toFastLog({ ...(base as object), logIndex: null } as never)).toBeNull();
  });
});

describe('transport options', () => {
  it('HTTP: a 3 s timeout and no retries of its own (the lane retries)', () => {
    expect(HTTP_TRANSPORT_OPTIONS).toEqual({ timeout: 3_000, retryCount: 0 });
  });
  it('WebSocket: reconnects every 2 s practically forever, with a 3 s request timeout', () => {
    expect(WEBSOCKET_TRANSPORT_OPTIONS.reconnect).toEqual({ attempts: 1_000_000, delay: 2_000 });
    expect(WEBSOCKET_TRANSPORT_OPTIONS.timeout).toBe(3_000);
    expect(WEBSOCKET_TRANSPORT_OPTIONS.keepAlive).toBe(true);
  });
});
