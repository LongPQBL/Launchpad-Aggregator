import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { verifyV4Initialize } from './identity.js';

const zero = '0x0000000000000000000000000000000000000000';
const token = '0x1111111111111111111111111111111111111111';
const hook = '0x2222222222222222222222222222222222222222';
const poolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [zero, token, 3000, 60, hook],
));
const raw = {
  chainId: 4663, poolId, currency0: zero, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook,
  blockNumber: 100n, blockHash: `0x${'ab'.repeat(32)}`, txHash: `0x${'cd'.repeat(32)}`, logIndex: 2,
};

describe('verifyV4Initialize', () => {
  it('accepts an exact V4 key and keeps native ETH as the zero address', () => {
    expect(verifyV4Initialize(raw)).toMatchObject({
      chainId: 4663, protocol: 'uniswap_v4', poolId, currency0: zero, currency1: token,
      fee: 3000, tickSpacing: 60, hooks: hook, verified: true,
    });
  });

  it('rejects false IDs, reversed or equal currencies, and malformed event facts', () => {
    expect(verifyV4Initialize({ ...raw, poolId: `0x${'ef'.repeat(32)}` })).toBeNull();
    expect(verifyV4Initialize({ ...raw, currency0: token, currency1: zero })).toBeNull();
    expect(verifyV4Initialize({ ...raw, currency1: zero })).toBeNull();
    expect(verifyV4Initialize({ ...raw, logIndex: -1 })).toBeNull();
    expect(verifyV4Initialize({ ...raw, blockHash: 'bad' })).toBeNull();
  });
});
