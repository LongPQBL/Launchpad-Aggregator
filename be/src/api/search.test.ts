import { describe, expect, it } from 'vitest';
import { createApiServer } from './server.js';
import type { SearchStore } from './searchStore.js';

const data = { listSources: async () => [], getCoverage: async () => ({ complete: false, pendingSourceIds: [], missingRanges: [] }),
  listLaunches: async () => ({ items: [], nextCursor: null }), getLaunch: async () => null,
  listTrades: async () => ({ items: [], nextCursor: null }), listTransactions: async () => ({ items: [], nextCursor: null }),
  listCandles: async () => ({ items: [], complete: false }), listUsdCandles: async () => ({ items: [], complete: false }) };

describe('search API', () => {
  it('passes the trimmed query and a capped limit to the store', async () => {
    const calls: [string, number][] = [];
    const search: SearchStore = { async search(query, limit) { calls.push([query, limit]); return { tokens: [], pools: [] }; } };
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, search });
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=%20pons%20&limit=50' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tokens: [], pools: [] });
    expect(calls).toEqual([['pons', 10]]);
  });

  it('rejects a too-short query or a non-numeric limit, and reports 503 when no store is configured', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data });
    expect((await app.inject({ method: 'GET', url: '/v1/search?q=p' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/search?q=pons&limit=x' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/search?q=pons' })).statusCode).toBe(503);
  });
});

describe('global transactions API', () => {
  it('rejects a bad query and reports 503 when the store has no global feed', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data });
    expect((await app.inject({ method: 'GET', url: '/v1/transactions?limit=x' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/transactions' })).statusCode).toBe(503);
  });

  it('serves the feed from the store', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: { ...data, listAllTransactions: async () => ({ items: [], nextCursor: null }) } });
    const response = await app.inject({ method: 'GET', url: '/v1/transactions?limit=5&chainId=4663' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect((await app.inject({ method: 'GET', url: '/v1/transactions?chainId=4663,1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/transactions?chainId=4663,x' })).statusCode).toBe(400);
  });
});

describe('wallet positions API', () => {
  it('validates the address and limit, and serves positions from the store', async () => {
    const positions = { items: [] };
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data, wallets: { listPositions: async () => positions } });
    const wallet = `0x${'8b'.repeat(20)}`;
    expect((await app.inject({ method: 'GET', url: `/v1/wallets/${wallet}/positions` })).json()).toEqual(positions);
    expect((await app.inject({ method: 'GET', url: '/v1/wallets/not-an-address/positions' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/v1/wallets/${wallet}/positions?limit=0` })).statusCode).toBe(400);
    const without = await createApiServer({ feOrigin: 'http://localhost:3000', data });
    expect((await without.inject({ method: 'GET', url: `/v1/wallets/${wallet}/positions` })).statusCode).toBe(503);
  });
});
