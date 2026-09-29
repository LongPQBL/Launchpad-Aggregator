import type { paths } from './schema';

type LaunchesBody = paths['/v1/launches']['get']['responses'][200]['content']['application/json'];
type RawLaunchSummary = NonNullable<LaunchesBody['items']>[number];

export type QuoteAsset = Required<NonNullable<RawLaunchSummary['quoteAsset']>>;
export type LaunchSummary = Required<Omit<RawLaunchSummary, 'quoteAsset'>> & { quoteAsset: QuoteAsset };

export interface LaunchPage {
  items: readonly LaunchSummary[];
  nextCursor: string | null;
}

// be/src/api/routes/launches.ts only parses limit/cursor/chainId today; there is no
// server-side search or lifecycle-status filter to type against (see Task 2 ruling in the ledger).
export interface LaunchQuery {
  cursor?: string;
  chainId?: number;
  limit?: number;
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

async function request<T>(path: string, searchParams?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, BE_API_URL);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' });
  } catch (cause) {
    throw new ApiError(`Không gọi được ${path}`, cause);
  }

  if (!response.ok) {
    throw new ApiError(`${path} trả về lỗi ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getLaunches(query: LaunchQuery): Promise<LaunchPage> {
  return request<LaunchPage>('/v1/launches', { cursor: query.cursor, chainId: query.chainId, limit: query.limit });
}

export async function getSources(): Promise<SourceList> {
  return request<SourceList>('/v1/sources');
}

export function launchHref(chainId: number, tokenAddress: string): string {
  return `/launches/${chainId}/${tokenAddress}`;
}
