import type { PoolDayHistory } from '../pools/history.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerCoverageRoutes } from './routes/coverage.js';
import { registerLaunchRoutes } from './routes/launches.js';
import { registerEventsRoute } from './routes/events.js';
import { registerPoolRoutes } from './routes/pools.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerWalletRoutes } from './routes/wallets.js';
import type { WalletStore } from './walletStore.js';
import type { SearchStore } from './searchStore.js';
import type { PoolApiStore } from './poolStore.js';
import { ApiEventBus } from './events.js';
import type { LaunchParityCoverage } from '../coverage/repairRanges.js';
import type { LaunchSort, SortDirection } from './metricCursor.js';

export interface Page<T> { items: readonly T[]; nextCursor: string | null }
export interface LaunchSummary {
  // name/symbol are null until core-metadata enrichment resolves them — a near-realtime-synced
  // launch is visible immediately with its address as the display fallback.
  chainId: number; tokenAddress: string; name: string | null; symbol: string | null; platform: string; protocolVersion: string;
  quoteAsset: { address: string; symbol: string | null; decimals: number | null }; lifecycleStatus: string;
  tokenDecimals: number | null;
  officialVolume24h: string | null; coverageStatus: string;
  // marketCapUsd always equals fdvUsd in this project (bonding-curve launches mint their full
  // supply at launch, no vesting) — see spec docs/superpowers/specs/2026-10-01-uniswap-parity-stats-design.md §4.
  fdvUsd: string | null; marketCapUsd: string | null; priceUsd: string | null;
  tvlUsd: string | null; tvlBasis: string | null; tvlBlockNumber: string | null;
  tvlPriceSource: string | null; tvlPriceUpdatedAt: number | null; tvlUnavailableReason: string | null;
  week52High: string | null; week52Low: string | null;
  logoUri: string | null; websiteUrl: string | null; twitterUrl: string | null;
  launchTimestamp: string | null; change1h: string | null; change1d: string | null;
  officialVolume24hUsd: string | null; officialVolume24hUsdApprox: boolean; officialVolume24hUsdAsOf: string | null;
}
export interface LaunchDetail extends LaunchSummary {
  description: string | null;
  officialVenues: readonly { id: string; kind: string; ref: string; effectiveFromBlock: string; effectiveToBlock: string | null }[];
  priceQuote: string | null;
  priceStale: boolean;
  quotePriceUsd: string | null;
}
/** The bonding-curve venue of a launch on its own (the launch endpoints merge the curve with the V4 pool). */
export interface CurveSummary {
  venueId: string;
  curveAddress: string;
  /** False once the curve has handed over (its venue has an effective_to_block). */
  active: boolean;
  /** Quote-asset volume over the last 24h on the curve venue only. */
  volume24hQuote: string;
  tradeCount24h: number;
  lastPriceQuote: string | null;
}

export interface TradeResponse {
  venueId: string; blockNumber: string; txHash: string; logIndex: number; timestamp: number; side: string;
  // null when the launch's token/quote decimals are still unresolved (core-metadata enrichment
  // pending) — the raw amount exists on-chain, but no human-scaled amount can be shown without
  // fabricating a decimals count.
  activityKind: string; tokenAmount: string | null; quoteAmount: string | null; priceQuote: string | null; traderAddress: string;
  usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}
export interface TransactionResponse {
  source: 'official' | 'pool';
  venueId: string | null;
  pool: { protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string } | null;
  blockNumber: string; txHash: string; logIndex: number; timestamp: number;
  side: 'buy' | 'sell'; activityKind: string | null;
  tokenAmount: string | null; quoteAmount: string | null; quoteAssetAddress: string | null;
  traderAddress: string;
  usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}
// One row of the global latest-trades feed: an official venue trade plus the launch it belongs to.
export interface GlobalTransactionResponse {
  // 'pool' = a swap in a pool that holds this launched token (not an official venue); side is relative to the token.
  source: 'official' | 'pool';
  token: { chainId: number; tokenAddress: string; name: string | null; symbol: string | null; logoUri: string | null };
  venueId: string | null;
  pool: { protocol: 'uniswap_v4' | 'uniswap_v3' | 'uniswap_v2'; poolId: string } | null;
  blockNumber: string; txHash: string; logIndex: number; timestamp: number;
  side: string; activityKind: string | null;
  tokenAmount: string | null; quoteAmount: string | null;
  quoteAsset: { address: string; symbol: string | null; logoUri: string | null };
  traderAddress: string;
  usdValue: string | null; usdValueApprox: boolean; usdValueStatus: 'priced' | 'pending' | 'unavailable';
}
export interface GlobalTransactionQuery extends Omit<ListQuery, 'chainId'> { chainId?: number | number[] }
export interface CandleResponse {
  intervalSeconds: number; bucketStart: number; open: string; high: string; low: string; close: string; quoteVolume: string;
}
export interface UsdCandleResponse {
  intervalSeconds: number; bucketStart: number; open: string; high: string; low: string; close: string;
  volumeUsd: string; tradeCount: number; computedAt: string;
}
export interface ListQuery { limit: number; cursor?: string; chainId?: number; venue?: 'curve' }
export interface LaunchListQuery extends Omit<ListQuery, 'chainId'> { chainId?: number | number[]; search?: string; status?: string; platform?: string | string[]; sort?: LaunchSort; direction?: SortDirection }

// Observability for the near-realtime incremental sync path (be/src/envioSync/incrementalSync.ts),
// separate from the sources-table-based coverage above (which only the old full-table sync writes).
// A stream's "confirmed" block is the minimum contiguous block actually applied, not merely read —
// see confirmedSourceBlock's own doc comment for why those differ while an event sits unresolved.
export interface IncrementalSyncCoverage {
  observedEnvioHead: string | null;
  tailConfirmedBlock: string | null;
  historyConfirmedBlock: string | null;
  tailLagBlocks: string | null;
  historyBacklogBlocks: string | null;
  unresolvedEventCount: number;
  pendingCoreMetadataCount: number;
  repair: { lastRunAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureReason: string | null; failureCount: number };
}

export interface ApiDeps {
  feOrigin: string;
  events?: ApiEventBus;
  pools?: PoolApiStore;
  search?: SearchStore;
  wallets?: WalletStore;
  data: {
    listSources(): Promise<readonly { id: string; chainId: number; platform: string; protocolVersion: string }[]>;
    getCoverage(): Promise<{ complete: boolean; pendingSourceIds: string[]; missingRanges: readonly { sourceId: string; fromBlock: string; toBlock: string; reason: string }[];
      latestFinalizedFence?: string | null; launchParity?: readonly LaunchParityCoverage[];
      parityAlerts?: { mismatchedSources: number; stalledSources: number; pendingRepairs: number };
      incrementalSync?: IncrementalSyncCoverage }>;
    listLaunches(query: LaunchListQuery): Promise<Page<LaunchSummary>>;
    getLaunch(chainId: number, tokenAddress: string): Promise<LaunchDetail | null>;
    listTrades(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TradeResponse>>;
    listTransactions(chainId: number, tokenAddress: string, query: ListQuery): Promise<Page<TransactionResponse>>;
    // Optional so test doubles that predate the global feed keep compiling; the route answers 503 without it.
    listAllTransactions?(query: GlobalTransactionQuery): Promise<Page<GlobalTransactionResponse>>;
    listCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number, venueKind?: string): Promise<{ items: readonly CandleResponse[]; complete: boolean }>;
    listUsdCandles(chainId: number, tokenAddress: string, intervalSeconds: number, before?: number): Promise<{ items: readonly UsdCandleResponse[]; complete: boolean }>;
    // Optional so test doubles that predate the Volume / TVL charts keep compiling; the route answers 503 without it.
    // Optional like listLaunchHistory: the route answers 503 without it.
    getCurveSummary?(chainId: number, tokenAddress: string): Promise<CurveSummary | null>;
    listLaunchHistory?(chainId: number, tokenAddress: string, window: { intervalSeconds: number; buckets: number; venueKind?: string }): Promise<{ items: PoolDayHistory[]; complete: boolean } | null>;
  };
}

export async function createApiServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify();
  const configuredOrigin = new URL(deps.feOrigin);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  await app.register(cors, { origin: (origin, callback) => {
    if (origin === deps.feOrigin) return callback(null, true);
    if (!origin || !loopbackHosts.has(configuredOrigin.hostname)) return callback(null, false);
    try {
      const requestedOrigin = new URL(origin);
      return callback(null, loopbackHosts.has(requestedOrigin.hostname)
        && requestedOrigin.protocol === configuredOrigin.protocol
        && requestedOrigin.port === configuredOrigin.port);
    } catch {
      return callback(null, false);
    }
  }, credentials: false });
  await app.register(swagger, { openapi: { info: { title: 'Launchpad Aggregator API', version: '0.1.0' } } });
  registerSourcesRoutes(app, deps);
  registerCoverageRoutes(app, deps);
  registerLaunchRoutes(app, deps);
  registerPoolRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerEventsRoute(app, deps.events ?? new ApiEventBus());
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  await app.ready();
  return app;
}
