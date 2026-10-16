import { describe, expect, it } from 'vitest';
import { readLensSnapshot } from './lens.js';

const key = { currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', currency1: '0xfee0613d27a49079aefc140a1a08f2383877e4f0', fee: 0, tick_spacing: 200, hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' };
const answer = (overrides: Record<string, unknown>) => ({ coreAmount0: 2_084_981_831n, coreAmount1: 7n * 10n ** 26n, hookReserves0: 0n, hookReserves1: 0n, hookEffective0: 0n, hookEffective1: 0n,
  sqrtPriceX96: 2n ** 96n, tick: 0, activeLiquidity: 1n, blockNumber: 1n, statsProvider: key.hooks, hookPermissions: 0, hasCustomAccounting: false, statsStatus: 1, ...overrides });
const clientWith = (result: Record<string, unknown>) => ({ getBlockNumber: async () => 100n, readContract: async () => result }) as never;

// Uniswap V4 permission bits: 13 beforeInitialize ... 7 beforeSwap, 3 beforeSwapReturnsDelta, 2 afterSwapReturnsDelta, 1 afterAddLiquidityReturnsDelta, 0 afterRemoveLiquidityReturnsDelta.
const PONS_HOOK = 0b10000001000100; // 8260: beforeInitialize, beforeSwap, afterSwapReturnsDelta

describe('readLensSnapshot', () => {
  it('reads a pool with standard accounting', async () => {
    expect(await readLensSnapshot(clientWith(answer({})), key)).toMatchObject({ coreAmount0: 2_084_981_831n });
  });
  it('reads a pool whose hook only takes a fee out of swaps (afterSwap delta) and holds nothing of its own', async () => {
    const snapshot = await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: PONS_HOOK })), key);
    expect(snapshot).toMatchObject({ coreAmount0: 2_084_981_831n, coreAmount1: 7n * 10n ** 26n });
  });
  it('does not answer for a hook that can replace the swap curve (beforeSwap delta)', async () => {
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: PONS_HOOK | 0b1000 })), key)).toBeNull();
  });
  it('does not answer for a hook that changes what liquidity holds (add / remove delta)', async () => {
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: 0b10 })), key)).toBeNull();
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: 0b1 })), key)).toBeNull();
  });
  it('does not answer when the hook holds funds of its own', async () => {
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: PONS_HOOK, hookReserves1: 5n })), key)).toBeNull();
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: PONS_HOOK, hookEffective0: 1n })), key)).toBeNull();
  });
  it('does not answer for a custom-accounting flag without a readable permission field', async () => {
    expect(await readLensSnapshot(clientWith(answer({ hasCustomAccounting: true, hookPermissions: undefined })), key)).toBeNull();
  });
  it('retries with a larger gas limit when a fine tick spacing makes the lens run out of gas', async () => {
    const gasSeen: bigint[] = [];
    const client = { getBlockNumber: async () => 100n, readContract: async (args: { gas: bigint }) => {
      gasSeen.push(args.gas);
      if (args.gas <= 30_000_000n) throw new Error('execution reverted');
      return answer({});
    } } as never;
    expect(await readLensSnapshot(client, { ...key, tick_spacing: 1 })).toMatchObject({ coreAmount0: 2_084_981_831n });
    expect(gasSeen).toEqual([30_000_000n, 150_000_000n]);
  });
  it('does not retry when the first read succeeds, and answers null when the larger read also fails', async () => {
    let calls = 0;
    await readLensSnapshot({ getBlockNumber: async () => 100n, readContract: async () => { calls += 1; return answer({}); } } as never, key);
    expect(calls).toBe(1);
    calls = 0;
    expect(await readLensSnapshot({ getBlockNumber: async () => 100n, readContract: async () => { calls += 1; throw new Error('execution reverted'); } } as never, key)).toBeNull();
    expect(calls).toBe(2);
  });
});
