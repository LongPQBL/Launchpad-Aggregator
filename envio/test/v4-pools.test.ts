import { describe, expect, it } from 'vitest';
import { createTestIndexer } from 'envio';

const v1Factory = '0x0c37a24f5d23a486fa692d1500881d698b1f77a4' as const;
const poolManager = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as const;
const ponsToken = '0x1111111111111111111111111111111111111111' as const;
const quoteToken = '0x2222222222222222222222222222222222222222' as const;
const otherToken0 = '0x6666666666666666666666666666666666666666' as const;
const otherToken1 = '0x7777777777777777777777777777777777777777' as const;
const hooks = '0x0000000000000000000000000000000000000000' as const;
const trader = '0x5555555555555555555555555555555555555555' as const;
const relevantPoolId = '0xaaaa111111111111111111111111111111111111111111111111111111aa' as const;
const otherPoolId = '0xbbbb222222222222222222222222222222222222222222222222222222bb' as const;

// Launches `ponsToken` via PonsV1LegacyFactory so KnownLaunchToken is populated before the V4 pool
// Initialize event — same causality the real chain guarantees (see EventHandlers.ts's
// involvesLaunchToken comment).
const launchPonsToken = { contract: 'PonsV1LegacyFactory' as const, event: 'TokenLaunched' as const,
  block: { number: 8600612 },
  params: { token: ponsToken, deployer: trader, dexFactory: v1Factory, pairToken: quoteToken,
    pool: '0x8888888888888888888888888888888888888888' as const,
    dexId: 0n, launchConfigId: 0n, positionId: 0n, restrictionsEndBlock: 0n, initialBuyAmount: 0n } };

describe('UniswapV4PoolManager pool source handlers', () => {
  it('stores Initialize and Swap rows for a pool that involves a Pons-launched token', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchPonsToken, { contract: 'UniswapV4PoolManager', event: 'Initialize',
      srcAddress: poolManager, block: { number: 8600802 },
      params: { id: relevantPoolId, currency0: ponsToken, currency1: quoteToken, fee: 3000n, tickSpacing: 60n,
        hooks, sqrtPriceX96: 2n ** 96n, tick: 0n } }] } } });
    expect((await indexer.RawV4Initialize.getAll())[0].poolId).toBe(relevantPoolId);

    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV4PoolManager', event: 'V4Swap',
      srcAddress: poolManager, block: { number: 8600803 }, transaction: { from: trader },
      params: { id: relevantPoolId, sender: trader, amount0: 1n, amount1: -1n,
        sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0n, fee: 3000n } }] } } });
    expect((await indexer.RawV4Swap.getAll())[0].txFrom).toBe(trader.toLowerCase());
  });

  it('writes no Initialize or Swap rows for a pool that involves no Pons-launched token', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV4PoolManager', event: 'Initialize',
      srcAddress: poolManager, block: { number: 8600802 },
      params: { id: otherPoolId, currency0: otherToken0, currency1: otherToken1, fee: 3000n, tickSpacing: 60n,
        hooks, sqrtPriceX96: 2n ** 96n, tick: 0n } }] } } });
    expect(await indexer.RawV4Initialize.getAll()).toHaveLength(0);

    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV4PoolManager', event: 'V4Swap',
      srcAddress: poolManager, block: { number: 8600803 }, transaction: { from: trader },
      params: { id: otherPoolId, sender: trader, amount0: 1n, amount1: -1n,
        sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0n, fee: 3000n } }] } } });
    expect(await indexer.RawV4Swap.getAll()).toHaveLength(0);
  });
});
