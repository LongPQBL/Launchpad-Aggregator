import { describe, expect, it } from 'vitest';
import { createTestIndexer } from 'envio';

const v1Factory = '0x0c37a24f5d23a486fa692d1500881d698b1f77a4' as const;
const v3Factory = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as const;
const v2Factory = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f' as const;
const ponsToken = '0x1111111111111111111111111111111111111111' as const;
const otherToken0 = '0x6666666666666666666666666666666666666666' as const;
const otherToken1 = '0x7777777777777777777777777777777777777777' as const;
const quoteToken = '0x2222222222222222222222222222222222222222' as const;
const v3Pool = '0x3333333333333333333333333333333333333333' as const;
const v2Pair = '0x4444444444444444444444444444444444444444' as const;
const trader = '0x5555555555555555555555555555555555555555' as const;

// Launches `ponsToken` via PonsV1LegacyFactory so KnownLaunchToken is populated before a pool/pair
// involving it is created — same causality the real chain guarantees (see EventHandlers.ts's
// involvesLaunchToken comment).
const launchPonsToken = { contract: 'PonsV1LegacyFactory' as const, event: 'TokenLaunched' as const,
  block: { number: 8600612 },
  params: { token: ponsToken, deployer: trader, dexFactory: v1Factory, pairToken: quoteToken,
    pool: '0x8888888888888888888888888888888888888888' as const,
    dexId: 0n, launchConfigId: 0n, positionId: 0n, restrictionsEndBlock: 0n, initialBuyAmount: 0n } };

describe('global Uniswap pool source handlers', () => {
  it('registers V3 from the canonical factory, then stores pool swap provenance, when the pool involves a Pons-launched token', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchPonsToken, { contract: 'UniswapV3Factory', event: 'PoolCreated',
      srcAddress: v3Factory, block: { number: 8600802 }, params: { token0: ponsToken, token1: quoteToken, fee: 3000n, tickSpacing: 60n, pool: v3Pool } }] } } });
    expect((await indexer.RawV3PoolCreated.getAll())[0].poolAddress).toBe(v3Pool);
    expect(indexer.chains[4663].UniswapV3Pool.addresses.map((x) => x.toLowerCase())).toContain(v3Pool);
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV3Pool', event: 'V3Swap',
      srcAddress: v3Pool, block: { number: 8600803 }, transaction: { from: trader },
      params: { sender: trader, recipient: trader, amount0: 1n, amount1: -1n,
        sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0n } }] } } });
    expect((await indexer.RawV3Swap.getAll())[0].txFrom).toBe(trader);
  });
  it('registers V2 from the canonical factory and keeps swap and reserve evidence, when the pair involves a Pons-launched token', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchPonsToken, { contract: 'UniswapV2Factory', event: 'PairCreated',
      srcAddress: v2Factory, block: { number: 8600800 }, params: { token0: ponsToken, token1: quoteToken, pair: v2Pair, _3: 1n } }] } } });
    expect((await indexer.RawV2PairCreated.getAll())[0].pairAddress).toBe(v2Pair);
    expect(indexer.chains[4663].UniswapV2Pair.addresses.map((x) => x.toLowerCase())).toContain(v2Pair);
    await indexer.process({ chains: { 4663: { simulate: [
      { contract: 'UniswapV2Pair', event: 'V2Sync', srcAddress: v2Pair, block: { number: 8600801 },
        params: { reserve0: 10n, reserve1: 20n } },
      { contract: 'UniswapV2Pair', event: 'V2Swap', srcAddress: v2Pair, block: { number: 8600801 },
        transaction: { from: trader }, params: { sender: trader, to: trader,
          amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n } },
    ] } } });
    expect((await indexer.RawV2Sync.getAll())[0].reserve1).toBe(20n);
    expect((await indexer.RawV2Swap.getAll())[0].txFrom).toBe(trader);
  });
  it('still registers an unrelated V3 pool for watching, but writes no catalog or swap rows for it', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV3Factory', event: 'PoolCreated',
      srcAddress: v3Factory, block: { number: 8600802 }, params: { token0: otherToken0, token1: otherToken1, fee: 3000n, tickSpacing: 60n, pool: v3Pool } }] } } });
    expect(await indexer.RawV3PoolCreated.getAll()).toHaveLength(0);
    // contractRegister has no entity-store access to check relevance, so the pool is still watched —
    // see EventHandlers.ts's "still registered for every pool" comment.
    expect(indexer.chains[4663].UniswapV3Pool.addresses.map((x) => x.toLowerCase())).toContain(v3Pool);
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV3Pool', event: 'V3Swap',
      srcAddress: v3Pool, block: { number: 8600803 }, transaction: { from: trader },
      params: { sender: trader, recipient: trader, amount0: 1n, amount1: -1n,
        sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0n } }] } } });
    expect(await indexer.RawV3Swap.getAll()).toHaveLength(0);
  });
  it('still registers an unrelated V2 pair for watching, but writes no catalog, swap, or sync rows for it', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV2Factory', event: 'PairCreated',
      srcAddress: v2Factory, block: { number: 8600800 }, params: { token0: otherToken0, token1: otherToken1, pair: v2Pair, _3: 1n } }] } } });
    expect(await indexer.RawV2PairCreated.getAll()).toHaveLength(0);
    expect(indexer.chains[4663].UniswapV2Pair.addresses.map((x) => x.toLowerCase())).toContain(v2Pair);
    await indexer.process({ chains: { 4663: { simulate: [
      { contract: 'UniswapV2Pair', event: 'V2Sync', srcAddress: v2Pair, block: { number: 8600801 },
        params: { reserve0: 10n, reserve1: 20n } },
      { contract: 'UniswapV2Pair', event: 'V2Swap', srcAddress: v2Pair, block: { number: 8600801 },
        transaction: { from: trader }, params: { sender: trader, to: trader,
          amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n } },
    ] } } });
    expect(await indexer.RawV2Sync.getAll()).toHaveLength(0);
    expect(await indexer.RawV2Swap.getAll()).toHaveLength(0);
  });
});
