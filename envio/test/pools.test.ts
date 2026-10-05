import { describe, expect, it } from 'vitest';
import { createTestIndexer } from 'envio';

const v3Factory = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as const;
const v2Factory = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f' as const;
const token0 = '0x1111111111111111111111111111111111111111' as const;
const token1 = '0x2222222222222222222222222222222222222222' as const;
const v3Pool = '0x3333333333333333333333333333333333333333' as const;
const v2Pair = '0x4444444444444444444444444444444444444444' as const;
const trader = '0x5555555555555555555555555555555555555555' as const;

describe('global Uniswap pool source handlers', () => {
  it('registers V3 from the canonical factory, then stores pool swap provenance', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV3Factory', event: 'PoolCreated',
      srcAddress: v3Factory, block: { number: 8930 }, params: { token0, token1, fee: 3000n, tickSpacing: 60n, pool: v3Pool } }] } } });
    expect((await indexer.RawV3PoolCreated.getAll())[0].poolAddress).toBe(v3Pool);
    expect(indexer.chains[4663].UniswapV3Pool.addresses.map((x) => x.toLowerCase())).toContain(v3Pool);
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV3Pool', event: 'V3Swap',
      srcAddress: v3Pool, block: { number: 8931 }, transaction: { from: trader },
      params: { sender: trader, recipient: trader, amount0: 1n, amount1: -1n,
        sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0n } }] } } });
    expect((await indexer.RawV3Swap.getAll())[0].txFrom).toBe(trader);
  });
  it('registers V2 from the canonical factory and keeps swap and reserve evidence', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [{ contract: 'UniswapV2Factory', event: 'PairCreated',
      srcAddress: v2Factory, block: { number: 8928 }, params: { token0, token1, pair: v2Pair, _3: 1n } }] } } });
    expect((await indexer.RawV2PairCreated.getAll())[0].pairAddress).toBe(v2Pair);
    expect(indexer.chains[4663].UniswapV2Pair.addresses.map((x) => x.toLowerCase())).toContain(v2Pair);
    await indexer.process({ chains: { 4663: { simulate: [
      { contract: 'UniswapV2Pair', event: 'V2Sync', srcAddress: v2Pair, block: { number: 8929 },
        params: { reserve0: 10n, reserve1: 20n } },
      { contract: 'UniswapV2Pair', event: 'V2Swap', srcAddress: v2Pair, block: { number: 8929 },
        transaction: { from: trader }, params: { sender: trader, to: trader,
          amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n } },
    ] } } });
    expect((await indexer.RawV2Sync.getAll())[0].reserve1).toBe(20n);
    expect((await indexer.RawV2Swap.getAll())[0].txFrom).toBe(trader);
  });
});
