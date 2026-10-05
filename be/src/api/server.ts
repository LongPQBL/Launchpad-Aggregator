import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerCoverageRoutes } from './routes/coverage.js';
import { registerLaunchRoutes } from './routes/launches.js';
import { registerEventsRoute } from './routes/events.js';
import { ApiEventBus } from './events.js';
import type { LaunchParityCoverage } from '../coverage/repairRanges.js';

export interface Page<T> { items: readonly T[]; nextCursor: string | null }
export interface LaunchSummary {
  // name/symbol are null until core-metadata enrichment resolves them — a near-realtime-synced
  // launch is visible immediately with its address as the display fallback.
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; platform: string; protocolVersion: string;
  quoteAsset: { address: string; symbol: string | null; decimals: number | null }; lifecycleStatus: string;
  officialVolume24h: string | null; coverageStatus: string;
  // marketCapUsd always equals fdvUsd in this project (bonding-curve launches mint their full
  // supply at launch, no vesting) — see spec docs/superpowers/specs/2026-10-01-uniswap-parity-stats-design.md §4.
  fdvUsd: string | null; marketCapUsd: string | null;
  tvlUsd: string | null; tvlBasis: string | null; tvlBlockNumber: string | null;
  tvlPriceSource: string | null; tvlPriceUpdatedAt: number | null; tvlUnavailableReason: string | null;
  week52High: string | null; week52Low: string | null;
  logoUri: string | null; websiteUrl: string | null; twitterUrl: string | null;
  launchTimestamp: string | null; change1h: string | null; change1d: string | null;
  officialVolume24hUsd: string | null; officialVolume24hUsdApprox: boolean;
}
export interface LaunchDetail extends LaunchSummary {
  description: string | null;
  officialVenues: readonly { id: string; kind: string; ref: string; effectiveFromBlock: string; effectiveToBlock: string | null }[];
  priceQuote: string | null;
  priceStale: boolean;
}
export interface TradeResponse {
  venueId: string; blockNumber: string; txHash: string; logIndex: number; timestamp: number; side: string;
  // null when the launch's token/quote decimals are still unresolved (core-metadata enrichment
  // pending) — the raw amount exists on-chain, but no human-scaled amount can be shown without
  // fabricating a decimals count.
  activityKind: string; tokenAmount: string | null; quoteAmount: string | null; priceQuote: string | null; traderAddress: string;
  usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}
export interface CandleResponse {
  intervalSeconds: number; bucketStart: number; open: string; high: string; low: string; close: string; quoteVolume: string;
}
export interface ListQuery { limit: number; cursor?: string; chainId?: number }
export interface LaunchListQuery extends ListQuery { search?: string; status?: string; platform?: string; sort?: 'volume24hUsd' | 'recent' }

export interface ApiDeps {
  feOrigin: string;
  events?: ApiEventBus;
  data: {
    listSources(): Promise<readonly { id: string; chainId: number; platform: string; protocolVersion: string }[]>;
    getCoverage(): Promise<{ complete: boolean; pendingSourceIds: string[]; missingRanges: readonly { sourceId: string; fromBlock: string; toBlock: string; reason: string }[];
      latestFinalizedFence?: string | null; launchParity?: readonly LaunchParityCoverage[];
      parityAlerts?: { mismatchedSources: number; stalledSources: number; pendingRepairs: number } }>;
    listLaunches(query: LaunchListQuery): Promise<Page<LaunchSummary>>;
    getLaunch(chainId: number, tokenAddress: string): Promise<LaunchDetail | null>;
    listTrades(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TradeResponse>>;
    listCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number): Promise<{ items: readonly CandleResponse[]; complete: boolean }>;
  };
}

export async function createApiServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: (origin, callback) => callback(null, origin === deps.feOrigin), credentials: false });
  await app.register(swagger, { openapi: { info: { title: 'Launchpad Aggregator API', version: '0.1.0' } } });
  registerSourcesRoutes(app, deps);
  registerCoverageRoutes(app, deps);
  registerLaunchRoutes(app, deps);
  registerEventsRoute(app, deps.events ?? new ApiEventBus());
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  await app.ready();
  return app;
}
