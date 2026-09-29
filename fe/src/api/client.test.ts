import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getLaunches, getSources, launchHref } from './client';

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
});
