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
  chainId?: number | readonly number[];
  limit?: number;
  search?: string;
  status?: string;
  platform?: string | readonly string[];
  sort?: 'volume24hUsd' | 'recent' | 'fdvUsd' | 'tvlUsd' | 'change1h' | 'change1d';
  direction?: 'asc' | 'desc';
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
  constructor(message: string, override readonly cause?: unknown, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function apiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_BE_API_URL ?? 'http://127.0.0.1:3001';
  }
  return process.env.BE_API_URL ?? 'http://127.0.0.1:3001';
}
const REQUEST_TIMEOUT_MS = 8_000;

async function rawFetch(path: string, searchParams?: Record<string, string | number | readonly string[] | readonly number[] | undefined>,
  signal?: AbortSignal): Promise<Response> {
  const url = new URL(path, apiBaseUrl());
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, cache: 'no-store' });
  } catch (cause) {
    throw new ApiError(`Failed to call ${path}`, cause);
  }
}

async function request<T>(path: string, searchParams?: Record<string, string | number | readonly string[] | readonly number[] | undefined>,
  signal?: AbortSignal): Promise<T> {
  const response = await rawFetch(path, searchParams, signal);
  if (!response.ok) {
    throw new ApiError(`${path} returned error ${response.status}`, undefined, response.status);
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
    direction: query.direction,
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

export function findActiveVenue(officialVenues: readonly OfficialVenue[], kind: string): OfficialVenue | undefined {
  return officialVenues.find((venue) => venue.kind === kind && venue.effectiveToBlock === null);
}

type TradesBody = paths['/v1/launches/{chainId}/{tokenAddress}/trades']['get']['responses'][200]['content']['application/json'];

export type Trade = Required<NonNullable<TradesBody['items']>[number]>;

export interface TradePage {
  items: readonly Trade[];
  nextCursor: string | null;
}

export interface TradeQuery {
  cursor?: string;
  limit?: number;
  /** Only the bonding-curve venue's rows (the launch endpoints otherwise merge every official venue). */
  venue?: 'curve';
}

type TransactionsBody = paths['/v1/launches/{chainId}/{tokenAddress}/transactions']['get']['responses'][200]['content']['application/json'];

export type Transaction = Required<NonNullable<TransactionsBody['items']>[number]>;

export interface TransactionPage {
  items: readonly Transaction[];
  nextCursor: string | null;
}

type CandlesBody = paths['/v1/launches/{chainId}/{tokenAddress}/candles']['get']['responses'][200]['content']['application/json'];

export type Candle = Required<Pick<NonNullable<CandlesBody['items']>[number], 'intervalSeconds' | 'bucketStart' | 'open' | 'high' | 'low' | 'close' | 'quoteVolume'>>;

export interface CandlePage {
  items: readonly Candle[];
  complete: boolean;
}

export interface CandleQuery {
  intervalSeconds?: number;
  before?: number;
  currency?: 'quote' | 'usd';
  venue?: 'curve';
}

export async function getLaunchDetail(chainId: number, tokenAddress: string): Promise<LaunchDetail | null> {
  const path = `/v1/launches/${chainId}/${tokenAddress}`;
  const response = await rawFetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(`${path} returned error ${response.status}`);
  return (await response.json()) as LaunchDetail;
}

export async function getLaunchTrades(chainId: number, tokenAddress: string, query: TradeQuery = {}): Promise<TradePage> {
  return request<TradePage>(`/v1/launches/${chainId}/${tokenAddress}/trades`, { cursor: query.cursor, limit: query.limit, venue: query.venue });
}

export async function getLaunchTransactions(chainId: number, tokenAddress: string, query: TradeQuery = {}): Promise<TransactionPage> {
  return request<TransactionPage>(`/v1/launches/${chainId}/${tokenAddress}/transactions`, { cursor: query.cursor, limit: query.limit, venue: query.venue });
}

export async function getLaunchCandles(chainId: number, tokenAddress: string, query: CandleQuery = {}): Promise<CandlePage> {
  return request<CandlePage>(`/v1/launches/${chainId}/${tokenAddress}/candles`, {
    intervalSeconds: query.intervalSeconds,
    before: query.before,
    currency: query.currency,
    venue: query.venue,
  });
}

// Pool metrics are scoped to a verified pool and never reuse official launch values.
type PoolsBody = paths['/v1/pools']['get']['responses'][200]['content']['application/json'];
type RawPool = NonNullable<PoolsBody['items']>[number];
export type PoolSummary = Required<RawPool>;
export interface PoolPage { items: readonly PoolSummary[]; nextCursor: string | null; supportedProtocols: readonly string[] }
export interface PoolQuery { chainId?: number; tokenAddress?: string; cursor?: string; limit?: number; protocol?: string; excludeOfficial?: boolean }
export function poolHref(pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId'>, displayedToken?: string): string {
  const path = `/pools/${pool.chainId}/${pool.protocol}/${encodeURIComponent(pool.poolId)}`;
  return displayedToken ? `${path}?displayedToken=${encodeURIComponent(displayedToken)}` : path;
}
export async function getPools(query: PoolQuery = {}): Promise<PoolPage> {
  return request<PoolPage>('/v1/pools', { chainId: query.chainId, tokenAddress: query.tokenAddress,
    cursor: query.cursor, limit: query.limit, protocol: query.protocol });
}
export async function getLaunchPools(chainId: number, tokenAddress: string, query: Omit<PoolQuery, 'chainId' | 'tokenAddress'> = {}): Promise<PoolPage> {
  return request<PoolPage>(`/v1/launches/${chainId}/${encodeURIComponent(tokenAddress)}/pools`,
    { cursor: query.cursor, limit: query.limit, protocol: query.protocol, excludeOfficial: query.excludeOfficial ? 'true' : undefined });
}
export async function getPoolDetail(chainId: number, protocol: string, poolId: string, displayedToken?: string): Promise<PoolSummary | null> {
  const path = `/v1/pools/${chainId}/${encodeURIComponent(protocol)}/${encodeURIComponent(poolId)}`;
  const response = await rawFetch(path, { displayedToken });
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(`${path} returned error ${response.status}`);
  return (await response.json()) as PoolSummary;
}
type PoolTradesBody = paths['/v1/pools/{chainId}/{protocol}/{poolId}/trades']['get']['responses'][200]['content']['application/json'];
export type PoolTrade = Required<NonNullable<PoolTradesBody['items']>[number]>;
export interface PoolTradePage { items: readonly PoolTrade[]; nextCursor: string | null }
type PoolCandlesBody = paths['/v1/pools/{chainId}/{protocol}/{poolId}/candles']['get']['responses'][200]['content']['application/json'];
export type PoolCandle = Required<NonNullable<PoolCandlesBody['items']>[number]>;
export interface PoolCandlePage { items: readonly PoolCandle[]; complete: boolean }
export async function getPoolTrades(pool: PoolSummary, cursor?: string): Promise<PoolTradePage> {
  return request<PoolTradePage>(`/v1/pools/${pool.chainId}/${pool.protocol}/${encodeURIComponent(pool.poolId)}/trades`,
    { displayedToken: pool.displayedToken, cursor });
}
export async function getPoolCandles(pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId' | 'displayedToken'>, intervalSeconds = 3600): Promise<PoolCandlePage> {
  return request<PoolCandlePage>(`/v1/pools/${pool.chainId}/${pool.protocol}/${encodeURIComponent(pool.poolId)}/candles`,
    { displayedToken: pool.displayedToken, intervalSeconds });
}

// Mirrors be/src/api/searchStore.ts. Lightweight identity-only hits: no market stats, so a dropdown can render fast.
export interface SearchTokenHit { chainId: number; tokenAddress: string; name: string | null; symbol: string | null; logoUri: string | null; platform: string;
  priceUsd: string | null; change1d: string | null }
export interface SearchPoolHit {
  chainId: number; protocol: string; poolId: string; fee: number; currency0: string; currency1: string;
  currency0Symbol: string | null; currency0LogoUri: string | null;
  currency1Symbol: string | null; currency1LogoUri: string | null; volume24hUsd: string | null; ponsDesignated: boolean;
  launchToken: { address: string; name: string | null; symbol: string | null; logoUri: string | null };
}
export interface SearchResults { tokens: readonly SearchTokenHit[]; pools: readonly SearchPoolHit[] }
export async function searchAll(query: string, signal?: AbortSignal, chainIds?: readonly number[], limit?: number, offset?: number): Promise<SearchResults> {
  return request<SearchResults>('/v1/search', { q: query, chainId: chainIds, limit, offset }, signal);
}

type GlobalTransactionsBody = paths['/v1/transactions']['get']['responses'][200]['content']['application/json'];
export type GlobalTransaction = Required<Omit<NonNullable<GlobalTransactionsBody['items']>[number], 'token' | 'quoteAsset'>> & {
  token: Required<NonNullable<NonNullable<GlobalTransactionsBody['items']>[number]['token']>>;
  quoteAsset: Required<NonNullable<NonNullable<GlobalTransactionsBody['items']>[number]['quoteAsset']>>;
};
export interface GlobalTransactionPage { items: readonly GlobalTransaction[]; nextCursor: string | null }
export async function getAllTransactions(query: { cursor?: string; limit?: number; chainId?: number | readonly number[] } = {}): Promise<GlobalTransactionPage> {
  return request<GlobalTransactionPage>('/v1/transactions', { cursor: query.cursor, limit: query.limit, chainId: query.chainId });
}

type PoolHistoryBody = paths['/v1/pools/{chainId}/{protocol}/{poolId}/history']['get']['responses'][200]['content']['application/json'];
export type PoolDayHistory = Required<NonNullable<PoolHistoryBody['items']>[number]>;
export interface PoolHistory { items: readonly PoolDayHistory[]; complete: boolean }
export async function getPoolHistory(pool: Pick<PoolSummary, 'chainId' | 'protocol' | 'poolId'>, intervalSeconds = 86_400, days = 30): Promise<PoolHistory> {
  return request<PoolHistory>(`/v1/pools/${pool.chainId}/${pool.protocol}/${encodeURIComponent(pool.poolId)}/history`, { intervalSeconds, days });
}

type LaunchHistoryBody = paths['/v1/launches/{chainId}/{tokenAddress}/history']['get']['responses'][200]['content']['application/json'];
export async function getLaunchHistory(chainId: number, tokenAddress: string, intervalSeconds = 86_400, venue?: 'curve'): Promise<PoolHistory> {
  return request<LaunchHistoryBody & PoolHistory>(`/v1/launches/${chainId}/${tokenAddress}/history`, { intervalSeconds, venue });
}

type CurveSummaryBody = paths['/v1/launches/{chainId}/{tokenAddress}/curve']['get']['responses'][200]['content']['application/json'];
export type CurveSummary = Required<Omit<CurveSummaryBody, 'lastPriceQuote'>> & { lastPriceQuote: string | null };

// The curve venue on its own; null (404) when the launch has no bonding-curve venue.
export async function getCurveSummary(chainId: number, tokenAddress: string): Promise<CurveSummary | null> {
  const path = `/v1/launches/${chainId}/${tokenAddress}/curve`;
  const response = await rawFetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(`${path} returned error ${response.status}`, undefined, response.status);
  return (await response.json()) as CurveSummary;
}

type WalletPositionsBody = paths['/v1/wallets/{address}/positions']['get']['responses'][200]['content']['application/json'];
type RawWalletPosition = NonNullable<WalletPositionsBody['items']>[number];
export type WalletPosition = Required<Omit<RawWalletPosition, 'token' | 'quoteAsset'>> & {
  token: Required<NonNullable<RawWalletPosition['token']>>;
  quoteAsset: Required<NonNullable<RawWalletPosition['quoteAsset']>>;
};
export interface WalletPositions { items: readonly WalletPosition[] }
// Without a chainId the positions on every indexed chain are returned.
export async function getWalletPositions(address: string, signal?: AbortSignal, chainId?: number): Promise<WalletPositions> {
  return request<WalletPositions>(`/v1/wallets/${encodeURIComponent(address)}/positions`, { chainId }, signal);
}
