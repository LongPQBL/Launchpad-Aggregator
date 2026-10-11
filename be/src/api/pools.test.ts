import { describe, expect, it } from 'vitest';
import { createApiServer } from './server.js';
import type { PoolApiStore } from './poolStore.js';

const token = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const id = `0x${'a'.repeat(64)}`;
const item = { chainId: 4663, protocol: 'uniswap_v4' as const, poolId: id, currency0: token,
  currency1: other, displayedToken: token, fee: 3000, tickSpacing: 60,
  currency0Symbol: null, currency0Name: null, currency0LogoUri: null, currency0Decimals: 18,
  currency1Symbol: null, currency1Name: null, currency1LogoUri: null, currency1Decimals: null,
  hooks: '0x0000000000000000000000000000000000000000', createdBlock: '100', createdTimestamp: null,
  ponsDesignated: false, launchTokenAddress: token, volume24hUsd: null, volume30dUsd: null, volume24hChange: null, tvlChange: null, priceInQuote: null,
  priceUsd: null, fdvUsd: null, tvlUsd: null, change1h: null, change1d: null,
  poolBalances: { displayedAmountRaw: '3000000000000000000', otherAmountRaw: '2000000000000000000', priceInQuote: '1' },
  coverageStatus: 'backfilling', lastTradeTimestamp: null };
function setup() {
  const calls: unknown[] = [];
  const pools: PoolApiStore = {
    async listPools(query) { if (query.protocol && query.protocol !== 'uniswap_v4') throw new Error('Unsupported pool protocol');
      calls.push(query); return { items: [item], nextCursor: null, supportedProtocols: ['uniswap_v4'] }; },
    async getPool(_key, displayed) { return displayed && displayed !== token && displayed !== other ? null : { ...item, displayedToken: displayed ?? token }; },
    async resolvePoolSide(_key, displayed) { return displayed && displayed !== token && displayed !== other ? null : displayed ?? token; },
    async listPoolTrades() { return { items: [], nextCursor: null }; },
    async listPoolCandles() { return { items: [], complete: false }; },
  };
  const data = { listSources: async () => [], getCoverage: async () => ({ complete: false, pendingSourceIds: [], missingRanges: [] }),
    listLaunches: async () => ({ items: [], nextCursor: null }), getLaunch: async () => ({ tokenAddress: token } as never),
    listTrades: async () => ({ items: [], nextCursor: null }), listTransactions: async () => ({ items: [], nextCursor: null }),
    listCandles: async () => ({ items: [], complete: false }), listUsdCandles: async () => ({ items: [], complete: false }) };
  return { calls, pools, data };
}
describe('pool API', () => {
  it('lists pools and exact launch membership with selected side', async () => {
    const { calls, pools, data } = setup();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools });
    const all = await app.inject({ method: 'GET', url: '/v1/pools?chainId=4663&limit=1' });
    expect(all.statusCode).toBe(200);
    expect(all.json().items[0].volume24hUsd).toBeNull();
    expect(all.json().items[0].currency0Decimals).toBe(18);
    expect(all.json().items[0].currency1Decimals).toBeNull();
    const linked = await app.inject({ method: 'GET', url: `/v1/launches/4663/${token}/pools` });
    expect(linked.statusCode).toBe(200);
    expect(calls).toEqual([{ chainId: 4663, limit: 1 }, { chainId: 4663, limit: 50, tokenAddress: token }]);
    const detail = await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v4/${id}?displayedToken=${other}` });
    expect(detail.json().displayedToken).toBe(other);
    expect(detail.json().poolBalances).toEqual(item.poolBalances);
    await app.close();
  });
  it('rejects malformed identities, unsupported sources, and invalid query', async () => {
    const { pools, data } = setup();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools });
    expect((await app.inject({ method: 'GET', url: '/v1/pools?protocol=uniswap_v3' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v3/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/pools/4663/uniswap_v4/bad' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v4/${id}/candles?intervalSeconds=7` })).statusCode).toBe(400);
    await app.close();
  });
  it('serves pool history per range and validates the range', async () => {
    const { pools, data } = setup();
    const history = { items: [{ day: 86_400, tradeCount: 1, volumeUsd: '6', tvlUsd: null }], complete: true };
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools: { ...pools, listPoolHistory: async () => history } });
    const url = `/v1/pools/4663/uniswap_v4/${id}/history`;
    const ok = await app.inject({ method: 'GET', url: `${url}?range=1w` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(history);
    expect((await app.inject({ method: 'GET', url: `${url}?range=5m` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${url}?range=1D` })).statusCode).toBe(400);
    const seen: unknown[] = [];
    const spy = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools: { ...pools, listPoolHistory: async (_key, window) => { seen.push(window); return history; } } });
    expect((await spy.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await spy.inject({ method: 'GET', url: `${url}?range=1y` })).statusCode).toBe(200);
    expect(seen).toEqual([{ intervalSeconds: 300, buckets: 288 }, { intervalSeconds: 86_400, buckets: 365 }]);
    const without = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools });
    expect((await without.inject({ method: 'GET', url })).statusCode).toBe(503);
  });
  it('serves pool liquidity for V3/V4 only, 404 for V2 or an unknown pool, 503 without a reader', async () => {
    const { pools, data } = setup();
    const answer = { protocol: 'uniswap_v4', blockNumber: '9', tickSpacing: 60, feePips: 500, currentTick: 0, price: 1, priceInverse: 1, activeLiquidity: '5',
      token0: { address: '0xa', decimals: 18 }, token1: { address: '0xb', decimals: 18 },
      ranges: [{ tickLower: -60, tickUpper: 60, priceLower: 0.99, priceUpper: 1.01, liquidity: '5', active: true }],
      depth: { asks: [{ price: 1.01, amount0: 1, total1: 1, cumulative1: 1 }], bids: [], spreadPercent: 0.1 }, complete: true, unavailableReason: null };
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools: { ...pools, getPoolLiquidity: async (key) => (key.protocol === 'uniswap_v4' ? answer as never : null) } });
    const ok = await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v4/${id}/liquidity` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(answer);
    expect((await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v2/0x${'ab'.repeat(20)}/liquidity` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v3/0x${'cd'.repeat(20)}/liquidity` })).statusCode).toBe(404);
    const without = await createApiServer({ feOrigin: 'http://localhost:3000', data, pools });
    expect((await without.inject({ method: 'GET', url: `/v1/pools/4663/uniswap_v4/${id}/liquidity` })).statusCode).toBe(503);
  });
});
