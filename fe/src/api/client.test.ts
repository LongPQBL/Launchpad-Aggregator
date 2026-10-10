import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, findActiveVenue, getCurveSummary, getLaunchCandles, getLaunchHistory, getLaunchTransactions, getLaunches, getSources, launchHref, type OfficialVenue } from './client';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

describe('client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests launches with cursor and chainId query params when provided', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await getLaunches({ cursor: 'abc', chainId: 4663 });

    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.pathname).toBe('/v1/launches');
    expect(requested.searchParams.get('cursor')).toBe('abc');
    expect(requested.searchParams.get('chainId')).toBe('4663');
  });

  it('serializes multiple chain and launchpad choices for the API', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await getLaunches({ chainId: [4663, 1], platform: ['pons', 'other'] });
    const requested = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requested.searchParams.get('chainId')).toBe('4663,1');
    expect(requested.searchParams.get('platform')).toBe('pons,other');
  });

  it('uses the public API URL for browser requests', async () => {
    vi.stubEnv('NEXT_PUBLIC_BE_API_URL', 'http://127.0.0.1:3101');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await getLaunches({ cursor: 'abc' });

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe('http://127.0.0.1:3101');
  });

  it('requests launches with search and status query params when provided', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await getLaunches({ search: 'demo', status: 'swept' });

    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.searchParams.get('search')).toBe('demo');
    expect(requested.searchParams.get('status')).toBe('swept');
  });

  it('sends the numeric sort column and direction to the API', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await getLaunches({ sort: 'change1d', direction: 'asc' });
    const requested = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(requested.searchParams.get('sort')).toBe('change1d');
    expect(requested.searchParams.get('direction')).toBe('asc');
  });

  it('requests launches without cursor/chainId params when omitted, relying on BE default newest-first order', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await getLaunches({});

    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.searchParams.has('cursor')).toBe(false);
    expect(requested.searchParams.has('chainId')).toBe(false);
  });

  it('returns the typed launch page from the response body', async () => {
    const fetchMock = vi.mocked(fetch);
    const body = {
      items: [{
        chainId: 4663, tokenAddress: '0xabc', name: 'Token', symbol: 'TKN', platform: 'pons', protocolVersion: 'v2',
        quoteAsset: { address: '0xquote', symbol: 'ROBIN', decimals: 18 },
        lifecycleStatus: 'trading', officialVolume24h: null, coverageStatus: 'backfilling',
      }],
      nextCursor: 'next-cursor',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    const result = await getLaunches({});

    expect(result).toEqual(body);
  });

  it('throws ApiError when the response is not ok', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));

    await expect(getLaunches({})).rejects.toBeInstanceOf(ApiError);
  });

  it('throws ApiError when fetch itself rejects', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    await expect(getLaunches({})).rejects.toBeInstanceOf(ApiError);
  });

  it('bounds every request with an abort signal so a hung BE does not hang the page', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    await getLaunches({});

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the source list from GET /v1/sources', async () => {
    const fetchMock = vi.mocked(fetch);
    const body = { items: [{ id: 'pons-v2', chainId: 4663, platform: 'pons', protocolVersion: 'v2' }] };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    const result = await getSources();

    expect(result).toEqual(body);
  });

  it('builds a different href for the same token address on a different chain', () => {
    const hrefOnRobinhood = launchHref(4663, '0xabc');
    const hrefOnOtherChain = launchHref(1, '0xabc');

    expect(hrefOnRobinhood).not.toBe(hrefOnOtherChain);
    expect(hrefOnRobinhood).toBe('/launches/4663/0xabc');
    expect(hrefOnOtherChain).toBe('/launches/1/0xabc');
  });

  describe('curve-scoped launch requests', () => {
    const token = '0x1111111111111111111111111111111111111111';

    it('adds venue=curve to transactions, candles and history only when asked', async () => {
      const fetchMock = vi.mocked(fetch);
      for (let i = 0; i < 4; i += 1) fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null, complete: true }));

      await getLaunchTransactions(4663, token, { venue: 'curve' });
      await getLaunchCandles(4663, token, { intervalSeconds: 3600, venue: 'curve' });
      await getLaunchHistory(4663, token, 86_400, 'curve');
      await getLaunchTransactions(4663, token);

      const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
      expect(urls[0]!.searchParams.get('venue')).toBe('curve');
      expect(urls[1]!.searchParams.get('venue')).toBe('curve');
      expect(urls[2]!.searchParams.get('venue')).toBe('curve');
      expect(urls[3]!.searchParams.has('venue')).toBe(false);
    });

    it('returns the curve summary, and null when the launch has no curve venue (404)', async () => {
      const fetchMock = vi.mocked(fetch);
      const summary = { venueId: 'v', curveAddress: token, active: true, volume24hQuote: '2', tradeCount24h: 1, lastPriceQuote: null };
      fetchMock.mockResolvedValueOnce(jsonResponse(summary));
      expect(await getCurveSummary(4663, token)).toEqual(summary);
      expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(`/v1/launches/4663/${token}/curve`);
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404 }));
      expect(await getCurveSummary(4663, token)).toBeNull();
    });
  });
});

describe('findActiveVenue', () => {
  function venue(overrides: Partial<OfficialVenue>): OfficialVenue {
    return { id: 'venue-1', kind: 'v4_pool', ref: '0xpool', effectiveFromBlock: '1', effectiveToBlock: null, ...overrides };
  }

  it('returns the matching venue when one exists and is active', () => {
    const active = venue({ kind: 'v4_pool', effectiveToBlock: null });
    const result = findActiveVenue([active], 'v4_pool');

    expect(result).toBe(active);
  });

  it('returns undefined when the matching kind exists but effectiveToBlock is not null (inactive)', () => {
    const inactive = venue({ kind: 'v4_pool', effectiveToBlock: '100' });

    expect(findActiveVenue([inactive], 'v4_pool')).toBeUndefined();
  });

  it('returns undefined when no venue of that kind exists at all', () => {
    const curve = venue({ kind: 'curve', effectiveToBlock: null });

    expect(findActiveVenue([curve], 'v4_pool')).toBeUndefined();
  });
});
