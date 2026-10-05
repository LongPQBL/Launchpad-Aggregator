import { describe, expect, it } from 'vitest';
import { V2_FACTORY, V3_FACTORY, verifyV2PairCreated, verifyV3PoolCreated } from './sourceRegistry.js';
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
const poolAddress = '0x3333333333333333333333333333333333333333';
const common = { chainId: 4663, token0: a, token1: b, blockNumber: 10000n,
  blockHash: `0x${'a'.repeat(64)}`, txHash: `0x${'b'.repeat(64)}`, logIndex: 0 };
describe('V3/V2 factory identity', () => {
  it('requires the canonical factory, ordered currencies and a pool address', () => {
    const v3 = { ...common, factoryAddress: V3_FACTORY, poolAddress, fee: 3000, tickSpacing: 60 };
    expect(verifyV3PoolCreated(v3)).toMatchObject({ protocol: 'uniswap_v3', currency0: a, currency1: b, fee: 3000 });
    expect(verifyV3PoolCreated({ ...v3, factoryAddress: V2_FACTORY })).toBeNull();
    expect(verifyV3PoolCreated({ ...v3, token0: b, token1: a })).toBeNull();
    expect(verifyV3PoolCreated({ ...v3, tickSpacing: 0 })).toBeNull();
  });
  it('requires V2 factory and uses pair identity, fixed V2 fee', () => {
    const v2 = { ...common, factoryAddress: V2_FACTORY, pairAddress: poolAddress };
    expect(verifyV2PairCreated(v2)).toMatchObject({ protocol: 'uniswap_v2', poolId: poolAddress, fee: 3000 });
    expect(verifyV2PairCreated({ ...v2, factoryAddress: V3_FACTORY })).toBeNull();
    expect(verifyV2PairCreated({ ...v2, pairAddress: a, blockNumber: 1n })).toBeNull();
  });
});
