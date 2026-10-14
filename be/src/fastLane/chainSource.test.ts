import { describe, expect, it } from 'vitest';
import { toFastLog } from './chainSource.js';

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
