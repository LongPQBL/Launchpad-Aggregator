import { describe, expect, it } from 'vitest';
import { createApiServer } from './server.js';
import { ApiEventBus } from './events.js';
import { InvalidVolumeCursorError } from './volumeCursor.js';
import { VolumeRankingUnavailableError } from '../market/launchVolume/state.js';

const address = '0x1111111111111111111111111111111111111111';
const launchSummary = {
  chainId: 4663, tokenAddress: address, name: 'Example', symbol: 'EX', platform: 'pons', protocolVersion: 'v2',
  quoteAsset: { address: '0x2222222222222222222222222222222222222222', symbol: 'USDG', decimals: 6 },
  lifecycleStatus: 'trading', officialVolume24h: null, coverageStatus: 'backfilling',
  fdvUsd: null, marketCapUsd: null, tvlUsd: null, tvlBasis: null, tvlBlockNumber: null,
  tvlPriceSource: null, tvlPriceUpdatedAt: null, tvlUnavailableReason: 'unavailable',
  week52High: null, week52Low: null,
  logoUri: null, websiteUrl: null, twitterUrl: null, launchTimestamp: null,
  change1h: null, change1d: null,
  officialVolume24hUsd: null, officialVolume24hUsdApprox: false, officialVolume24hUsdAsOf: null,
};
const launch = { ...launchSummary, description: null };

function data() {
  return {
    listSources: async () => [{ id: 'pons-v2', chainId: 4663, platform: 'pons', protocolVersion: 'v2' }],
    getCoverage: async () => ({ complete: false, pendingSourceIds: ['pons-v2-curve'], missingRanges: [] }),
    listLaunches: async () => ({ items: [launchSummary], nextCursor: null }),
    getLaunch: async () => ({ ...launch, officialVenues: [], priceQuote: null, priceStale: false }),
    listTrades: async () => ({ items: [], nextCursor: null }),
    listTransactions: async () => ({ items: [], nextCursor: null }),
    listCandles: async () => ({ items: [], complete: false }),
    listUsdCandles: async () => ({ items: [], complete: false }),
  };
}

describe('read-only API', () => {
  it('returns configured sources and honest incomplete coverage', async () => {
    const app = await createApiServer({
      feOrigin: 'http://localhost:3000',
      data: data(),
    });
    const sources = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(sources.statusCode).toBe(200);
    expect(sources.json()).toEqual({ items: [{ id: 'pons-v2', chainId: 4663, platform: 'pons', protocolVersion: 'v2' }] });
    const coverage = await app.inject({ method: 'GET', url: '/v1/coverage' });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json()).toEqual({ complete: false, pendingSourceIds: ['pons-v2-curve'], missingRanges: [] });
    await app.close();
  });

  it('routes launches by chain and address, and bounds pagination', async () => {
    const calls: Array<{ limit: number; cursor?: string; chainId?: number }> = [];
    const source = data();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: {
      ...source, listLaunches: async (query) => { calls.push(query); return { items: [launchSummary], nextCursor: null }; },
    } });
    const list = await app.inject({ method: 'GET', url: '/v1/launches?chainId=4663&limit=500' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [launchSummary], nextCursor: null });
    expect(calls).toEqual([{ chainId: 4663, limit: 100 }]);
    const detail = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ ...launch, officialVenues: [], priceQuote: null, priceStale: false });
    const invalid = await app.inject({ method: 'GET', url: '/v1/launches/4663/not-an-address' });
    expect(invalid.statusCode).toBe(404);
    const badCursor = await app.inject({ method: 'GET', url: '/v1/launches?cursor=bad' });
    expect(badCursor.statusCode).toBe(400);
    await app.close();
  });

  it('answers 503 with Retry-After while the volume ranking is unavailable, not a frozen or empty ranking', async () => {
    const source = data();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: {
      ...source, listLaunches: async () => { throw new VolumeRankingUnavailableError('backfill not complete'); },
    } });
    const response = await app.inject({ method: 'GET', url: '/v1/launches?sort=volume24hUsd' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('30');
    await app.close();
  });

  it('passes search and lifecycle-status filters through to the launch list, and rejects an unknown status', async () => {
    const calls: Array<{ limit: number; search?: string; status?: string }> = [];
    const source = data();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: {
      ...source, listLaunches: async (query) => { calls.push(query); return { items: [launchSummary], nextCursor: null }; },
    } });
    const withSearch = await app.inject({ method: 'GET', url: '/v1/launches?search=demo' });
    expect(withSearch.statusCode).toBe(200);
    const withStatus = await app.inject({ method: 'GET', url: '/v1/launches?status=swept' });
    expect(withStatus.statusCode).toBe(200);
    expect(calls).toEqual([{ limit: 50, search: 'demo' }, { limit: 50, status: 'swept' }]);
    const withUnknownStatus = await app.inject({ method: 'GET', url: '/v1/launches?status=not-a-status' });
    expect(withUnknownStatus.statusCode).toBe(400);
    await app.close();
  });

  it('maps an invalid/stale volume24hUsd cursor to 400, never an unhandled 500', async () => {
    const source = data();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: {
      ...source, listLaunches: async () => { throw new InvalidVolumeCursorError('Invalid cursor'); },
    } });
    const response = await app.inject({ method: 'GET', url: '/v1/launches?sort=volume24hUsd&cursor=tampered' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('serves token trades and candles without converting missing history to zero', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data() });
    const trades = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/trades?limit=2` });
    expect(trades.statusCode).toBe(200);
    expect(trades.json()).toEqual({ items: [], nextCursor: null });
    const candles = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/candles?intervalSeconds=60` });
    expect(candles.statusCode).toBe(200);
    expect(candles.json()).toEqual({ items: [], complete: false });
    await app.close();
  });

  it('serves merged transactions without fabricating pagination when there are none', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: { ...data(),
      listTransactions: async (_chainId, _tokenAddress, query) => { expect(query.limit).toBe(2); return { items: [], nextCursor: null }; } } });
    const response = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/transactions?limit=2` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    await app.close();
  });

  it('rejects an invalid transactions query the same way /trades does', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data() });
    const response = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/transactions?limit=0` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('accepts an exclusive candle page boundary and rejects malformed boundaries', async () => {
    const beforeValues: Array<number | undefined> = [];
    const source = data();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: { ...source,
      listCandles: async (_chainId, _tokenAddress, _interval, before) => {
        beforeValues.push(before);
        return { items: [], complete: false };
      },
    } });
    const valid = await app.inject({ method: 'GET',
      url: `/v1/launches/4663/${address}/candles?intervalSeconds=60&before=1700000000` });
    expect(valid.statusCode).toBe(200);
    expect(beforeValues).toEqual([1_700_000_000]);
    const invalid = await app.inject({ method: 'GET',
      url: `/v1/launches/4663/${address}/candles?before=not-a-time` });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('serves USD candles only when currency=usd, and rejects an unknown currency', async () => {
    const calls: string[] = [];
    const source = data();
    const usdItem = { intervalSeconds: 60, bucketStart: 1_700_000_000, open: '1.5', high: '2', low: '1', close: '1.8',
      volumeUsd: '120.5', tradeCount: 3, computedAt: '2026-10-05T12:00:00.000Z' };
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: { ...source,
      listCandles: async () => { calls.push('quote'); return { items: [], complete: false }; },
      listUsdCandles: async () => { calls.push('usd'); return { items: [usdItem], complete: true }; },
    } });
    const usd = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/candles?intervalSeconds=60&currency=usd` });
    expect(usd.statusCode).toBe(200);
    expect(usd.json().items).toEqual([usdItem]);
    const quote = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/candles?intervalSeconds=60` });
    expect(quote.statusCode).toBe(200);
    expect(calls).toEqual(['usd', 'quote']);
    const bad = await app.inject({ method: 'GET', url: `/v1/launches/4663/${address}/candles?currency=eur` });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('allows only the configured frontend origin in browser CORS', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data() });
    const allowed = await app.inject({ method: 'GET', url: '/v1/sources', headers: { origin: 'http://localhost:3000' } });
    const rejected = await app.inject({ method: 'GET', url: '/v1/sources', headers: { origin: 'https://other.example' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('sends the configured-origin CORS header on the SSE stream, so a browser EventSource is not blocked', async () => {
    const events = new ApiEventBus();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data(), events });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/v1/events`, {
        signal: controller.signal,
        headers: { origin: 'http://localhost:3000' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('streams compact resource-change events that a client can refetch', async () => {
    const events = new ApiEventBus();
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data(), events });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/v1/events`, { signal: controller.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      events.publish({ type: 'trade.created', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
      let chunk = '';
      for (let i = 0; i < 3 && !chunk.includes('event: trade.created'); i++) {
        chunk += new TextDecoder().decode((await reader.read()).value);
      }
      expect(chunk).toContain('event: trade.created');
      expect(chunk).toContain('"chainId":4663');
      expect(chunk).toContain('id: ');
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('publishes an OpenAPI document for the public read endpoints', async () => {
    const app = await createApiServer({ feOrigin: 'http://localhost:3000', data: data() });
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().paths)).toContain('/v1/launches/{chainId}/{tokenAddress}/trades');
    expect(Object.keys(response.json().paths)).toContain('/v1/launches/{chainId}/{tokenAddress}/transactions');
    expect(response.json().paths['/v1/launches'].get.responses['200'].content['application/json'].schema.properties.items).toBeDefined();
    await app.close();
  });
});
