import { describe, expect, it, vi } from 'vitest';
import { readVenueAmounts } from './tvlReserves.js';

const token = '0x1111111111111111111111111111111111111111';
const quote = '0x2222222222222222222222222222222222222222';
const blockNumber = 77_455_470n;

describe('readVenueAmounts', () => {
  it('counts only the real quote reserve of a Pons curve', async () => {
    const readContract = vi.fn(async ({ functionName, blockNumber: at }: { functionName: string; blockNumber: bigint }) => {
      expect(at).toBe(blockNumber);
      if (functionName === 'realQuoteReserve') return 15_700_717n;
      throw new Error('virtual reserve must not be read');
    });
    expect(await readVenueAmounts({ readContract }, { kind: 'curve', ref: '0x3333333333333333333333333333333333333333',
      token, quote, blockNumber })).toEqual({ tokenRaw: 0n, quoteRaw: 15_700_717n,
        blockNumber, basis: 'curve_real_quote', sqrtPriceX96: null, tokenIsCurrency0: null });
  });

  it('counts both actual ERC-20 balances of a verified V3 pool', async () => {
    const readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === 'token0') return token;
      if (functionName === 'token1') return quote;
      if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true];
      if (functionName === 'balanceOf') return address.toLowerCase() === token ? 100n : 200n;
      throw new Error(functionName);
    });
    expect(await readVenueAmounts({ readContract }, { kind: 'v3_pool', ref: '0x3333333333333333333333333333333333333333',
      token, quote, blockNumber })).toEqual({ tokenRaw: 100n, quoteRaw: 200n,
        blockNumber, basis: 'pool_custody', sqrtPriceX96: 2n ** 96n, tokenIsCurrency0: true });
  });

  it('accepts a V3 pool where quote is currency0 and token is currency1', async () => {
    const readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === 'token0') return quote;
      if (functionName === 'token1') return token;
      if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true];
      if (functionName === 'balanceOf') return address.toLowerCase() === token ? 100n : 200n;
      throw new Error(functionName);
    });
    expect(await readVenueAmounts({ readContract }, { kind: 'v3_pool', ref: '0x3333333333333333333333333333333333333333',
      token, quote, blockNumber })).toMatchObject({ tokenRaw: 100n, quoteRaw: 200n });
  });

  it('reads a V4 pool principal by its verified PoolKey instead of PoolManager balances', async () => {
    const launchToken = '0xc9e9ab90654f82893d7fd18b62f694992e8cef29';
    const nvda = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      expect(functionName).toBe('getPoolTVL');
      expect((args?.[1] as { hooks: string }).hooks.toLowerCase()).toBe('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');
      return { coreAmount0: 809_000n, coreAmount1: 10_000n, sqrtPriceX96: 2n ** 96n,
        hasCustomAccounting: true, statsStatus: 1 };
    });
    expect(await readVenueAmounts({ readContract }, { kind: 'v4_pool',
      ref: '0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1',
      token: launchToken, quote: nvda, blockNumber, v4PoolFee: 0, v4TickSpacing: 200 }))
      .toEqual({ tokenRaw: 809_000n, quoteRaw: 10_000n, blockNumber,
        basis: 'pool_principal', sqrtPriceX96: 2n ** 96n, tokenIsCurrency0: true });
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});
