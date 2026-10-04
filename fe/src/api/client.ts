import type { paths } from './schema';

type LaunchesBody = paths['/v1/launches']['get']['responses'][200]['content']['application/json'];
type RawLaunchSummary = NonNullable<LaunchesBody['items']>[number];

export type QuoteAsset = Required<NonNullable<RawLaunchSummary['quoteAsset']>>;
export type LaunchSummary = Required<Omit<RawLaunchSummary, 'quoteAsset'>> & { quoteAsset: QuoteAsset };

export interface LaunchPage {
  items: readonly LaunchSummary[];
  nextCursor: string | null;
}

export interface LaunchQuery {
  cursor?: string;
  chainId?: number;
  limit?: number;
  search?: string;
  status?: string;
  platform?: string;
  sort?: 'volume24hUsd' | 'recent';
}

// be/src/api/routes/sources.ts registers no Fastify response schema, so this shape is absent
// from be/openapi.json; it mirrors be/src/api/server.ts's `listSources()` return type instead.
export interface Source {
  id: string;
  chainId: number;
  platform: string;
  protocolVersion: string;
}

export interface SourceList {
  items: readonly Source[];
}

export class ApiError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const BE_API_URL = process.env.BE_API_URL ?? 'http://127.0.0.1:3001';
const REQUEST_TIMEOUT_MS = 8_000;

async function rawFetch(path: string, searchParams?: Record<string, string | number | undefined>): Promise<Response> {
  const url = new URL(path, BE_API_URL);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  try {
    return await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  } catch (cause) {
    throw new ApiError(`Failed to call ${path}`, cause);
  }
}

async function request<T>(path: string, searchParams?: Record<string, string | number | undefined>): Promise<T> {
  const response = await rawFetch(path, searchParams);
  if (!response.ok) {
    throw new ApiError(`${path} returned error ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getLaunches(query: LaunchQuery): Promise<LaunchPage> {
  return request<LaunchPage>('/v1/launches', {
    cursor: query.cursor,
    chainId: query.chainId,
    limit: query.limit,
    search: query.search,
    status: query.status,
    platform: query.platform,
    sort: query.sort,
  });
}

export async function getSources(): Promise<SourceList> {
  return request<SourceList>('/v1/sources');
}

export function launchHref(chainId: number, tokenAddress: string): string {
  return `/launches/${chainId}/${tokenAddress}`;
}

type LaunchDetailBody = paths['/v1/launches/{chainId}/{tokenAddress}']['get']['responses'][200]['content']['application/json'];

export type OfficialVenue = Required<NonNullable<LaunchDetailBody['officialVenues']>[number]>;
export type LaunchDetail = Required<Omit<LaunchDetailBody, 'quoteAsset' | 'officialVenues'>> & {
  quoteAsset: QuoteAsset;
  officialVenues: readonly OfficialVenue[];
};

type TradesBody = paths['/v1/launches/{chainId}/{tokenAddress}/trades']['get']['responses'][200]['content']['application/json'];

export type Trade = Required<NonNullable<TradesBody['items']>[number]>;

export interface TradePage {
  items: readonly Trade[];
  nextCursor: string | null;
}

export interface TradeQuery {
  cursor?: string;
  limit?: number;
}

type CandlesBody = paths['/v1/launches/{chainId}/{tokenAddress}/candles']['get']['responses'][200]['content']['application/json'];

export type Candle = Required<NonNullable<CandlesBody['items']>[number]>;

export interface CandlePage {
  items: readonly Candle[];
  complete: boolean;
}

export interface CandleQuery {
  intervalSeconds?: number;
  before?: number;
}

export async function getLaunchDetail(chainId: number, tokenAddress: string): Promise<LaunchDetail | null> {
  const path = `/v1/launches/${chainId}/${tokenAddress}`;
  const response = await rawFetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(`${path} returned error ${response.status}`);
  return (await response.json()) as LaunchDetail;
}

export async function getLaunchTrades(chainId: number, tokenAddress: string, query: TradeQuery = {}): Promise<TradePage> {
  return request<TradePage>(`/v1/launches/${chainId}/${tokenAddress}/trades`, { cursor: query.cursor, limit: query.limit });
}

export async function getLaunchCandles(chainId: number, tokenAddress: string, query: CandleQuery = {}): Promise<CandlePage> {
  return request<CandlePage>(`/v1/launches/${chainId}/${tokenAddress}/candles`, {
    intervalSeconds: query.intervalSeconds,
    before: query.before,
  });
}
