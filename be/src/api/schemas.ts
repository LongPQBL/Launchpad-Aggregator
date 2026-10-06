const quoteAsset = { type: 'object', properties: {
  address: { type: 'string' }, symbol: { type: 'string', nullable: true }, decimals: { type: 'integer', nullable: true },
} } as const;

export const coverageSchema = { type: 'object', properties: {
  complete: { type: 'boolean' },
  pendingSourceIds: { type: 'array', items: { type: 'string' } },
  missingRanges: { type: 'array', items: { type: 'object', properties: {
    sourceId: { type: 'string' }, fromBlock: { type: 'string' }, toBlock: { type: 'string' }, reason: { type: 'string' },
  } } },
  latestFinalizedFence: { type: 'string', nullable: true },
  launchParity: { type: 'array', items: { type: 'object', properties: {
    sourceId: { type: 'string' }, status: { type: 'string', enum: ['complete', 'mismatch', 'pending', 'unverified'] },
    auditedToBlock: { type: 'string', nullable: true }, finalizedTargetBlock: { type: 'string', nullable: true },
    envioWatermark: { type: 'string', nullable: true }, appWatermark: { type: 'string', nullable: true },
  } } },
  parityAlerts: { type: 'object', properties: {
    mismatchedSources: { type: 'integer' }, stalledSources: { type: 'integer' }, pendingRepairs: { type: 'integer' },
  } },
  incrementalSync: { type: 'object', properties: {
    observedEnvioHead: { type: 'string', nullable: true },
    tailConfirmedBlock: { type: 'string', nullable: true }, historyConfirmedBlock: { type: 'string', nullable: true },
    tailLagBlocks: { type: 'string', nullable: true }, historyBacklogBlocks: { type: 'string', nullable: true },
    unresolvedEventCount: { type: 'integer' }, pendingCoreMetadataCount: { type: 'integer' },
    repair: { type: 'object', properties: {
      lastRunAt: { type: 'string', nullable: true }, lastSuccessAt: { type: 'string', nullable: true },
      lastFailureAt: { type: 'string', nullable: true }, lastFailureReason: { type: 'string', nullable: true },
      failureCount: { type: 'integer' },
    } },
  } },
} } as const;

export const launchSummary = { type: 'object', properties: {
  chainId: { type: 'integer' }, tokenAddress: { type: 'string' },
  // null until core-metadata enrichment resolves it (be/src/launchpads/pons/coreMetadata.ts) — the
  // UI falls back to displaying tokenAddress as the name in that window.
  name: { type: 'string', nullable: true }, symbol: { type: 'string', nullable: true },
  platform: { type: 'string' }, protocolVersion: { type: 'string' }, quoteAsset,
  tokenDecimals: { type: 'integer', nullable: true },
  lifecycleStatus: { type: 'string' }, officialVolume24h: { type: 'string', nullable: true }, coverageStatus: { type: 'string' },
  fdvUsd: { type: 'string', nullable: true }, marketCapUsd: { type: 'string', nullable: true }, priceUsd: { type: 'string', nullable: true },
  tvlUsd: { type: 'string', nullable: true }, tvlBasis: { type: 'string', nullable: true },
  tvlBlockNumber: { type: 'string', nullable: true }, tvlPriceSource: { type: 'string', nullable: true },
  tvlPriceUpdatedAt: { type: 'integer', nullable: true }, tvlUnavailableReason: { type: 'string', nullable: true },
  week52High: { type: 'string', nullable: true }, week52Low: { type: 'string', nullable: true },
  logoUri: { type: 'string', nullable: true },
  websiteUrl: { type: 'string', nullable: true }, twitterUrl: { type: 'string', nullable: true },
  launchTimestamp: { type: 'string', nullable: true },
  change1h: { type: 'string', nullable: true }, change1d: { type: 'string', nullable: true },
  officialVolume24hUsd: { type: 'string', nullable: true }, officialVolume24hUsdApprox: { type: 'boolean' },
  officialVolume24hUsdAsOf: { type: 'string', format: 'date-time', nullable: true },
} } as const;

export const launchDetail = { type: 'object', properties: {
  ...launchSummary.properties,
  description: { type: 'string', nullable: true },
  officialVenues: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, kind: { type: 'string' }, ref: { type: 'string' },
    effectiveFromBlock: { type: 'string' }, effectiveToBlock: { type: 'string', nullable: true },
  } } },
  priceQuote: { type: 'string', nullable: true },
  priceStale: { type: 'boolean' },
} } as const;

export const trade = { type: 'object', properties: {
  venueId: { type: 'string' }, blockNumber: { type: 'string' }, txHash: { type: 'string' },
  logIndex: { type: 'integer' }, timestamp: { type: 'integer' }, side: { type: 'string' }, activityKind: { type: 'string' },
  tokenAmount: { type: 'string', nullable: true }, quoteAmount: { type: 'string', nullable: true }, priceQuote: { type: 'string', nullable: true },
  traderAddress: { type: 'string' },
  // usdValue is the trade's OWN historical quote-asset price at its exact (blockNumber, logIndex)
  // position, never the current/latest price — usdValueApprox is always true when usdValue is
  // non-null (the Chainlink round is itself an approximation of the true market price at that
  // moment). usdValueStatus explains a null usdValue: 'pending' means a verified feed exists but
  // the historical round isn't backfilled yet (a backfill job has been enqueued); 'unavailable'
  // means no verified feed exists for this quote asset at all.
  usdValue: { type: 'string', nullable: true }, usdValueApprox: { type: 'boolean' },
  usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] },
} } as const;

export const transaction = { type: 'object', properties: {
  source: { type: 'string', enum: ['official', 'pool'] },
  venueId: { type: 'string', nullable: true },
  pool: { type: 'object', nullable: true, properties: { protocol: { type: 'string' }, poolId: { type: 'string' } } },
  blockNumber: { type: 'string' }, txHash: { type: 'string' }, logIndex: { type: 'integer' }, timestamp: { type: 'integer' },
  side: { type: 'string' }, activityKind: { type: 'string', nullable: true },
  tokenAmount: { type: 'string', nullable: true }, quoteAmount: { type: 'string', nullable: true },
  quoteAssetAddress: { type: 'string', nullable: true }, traderAddress: { type: 'string' },
  usdValue: { type: 'string', nullable: true }, usdValueApprox: { type: 'boolean' },
  usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] },
} } as const;

export const candle = { type: 'object', properties: {
  intervalSeconds: { type: 'integer' }, bucketStart: { type: 'integer' },
  open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' },
  quoteVolume: { type: 'string' }, volumeUsd: { type: 'string' }, tradeCount: { type: 'integer' }, computedAt: { type: 'string', format: 'date-time' },
} } as const;

export function pageSchema(item: object) {
  return { type: 'object', properties: { items: { type: 'array', items: item }, nextCursor: { type: 'string', nullable: true } } } as const;
}

const nullableMetric = { type: 'string', nullable: true } as const;
export const poolSummary = { type: 'object', properties: {
  chainId: { type: 'integer' }, protocol: { type: 'string' }, poolId: { type: 'string' },
  currency0: { type: 'string' }, currency1: { type: 'string' }, displayedToken: { type: 'string' },
  currency0Symbol: nullableMetric, currency0Name: nullableMetric, currency0LogoUri: nullableMetric,
  currency0Decimals: { type: 'integer', nullable: true },
  currency1Symbol: nullableMetric, currency1Name: nullableMetric, currency1LogoUri: nullableMetric,
  currency1Decimals: { type: 'integer', nullable: true },
  fee: { type: 'integer' }, tickSpacing: { type: 'integer' }, hooks: { type: 'string' },
  createdBlock: { type: 'string' }, createdTimestamp: { type: 'integer', nullable: true },
  ponsDesignated: { type: 'boolean' },
  launchTokenAddress: nullableMetric, volume24hUsd: nullableMetric, priceInQuote: nullableMetric,
  priceUsd: nullableMetric, fdvUsd: nullableMetric, tvlUsd: nullableMetric, change1h: nullableMetric,
  change1d: nullableMetric, coverageStatus: { type: 'string' },
  lastTradeTimestamp: { type: 'integer', nullable: true },
} } as const;
export const poolPage = { type: 'object', properties: {
  items: { type: 'array', items: poolSummary }, nextCursor: nullableMetric,
  supportedProtocols: { type: 'array', items: { type: 'string' } },
} } as const;
export const poolTrade = { type: 'object', properties: {
  txHash: { type: 'string' }, logIndex: { type: 'integer' }, blockNumber: { type: 'string' },
  timestamp: { type: 'integer' }, traderAddress: { type: 'string' }, side: { type: 'string' },
  amount0Raw: { type: 'string' }, amount1Raw: { type: 'string' }, priceInQuote: nullableMetric,
  usdValue: nullableMetric, usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] },
} } as const;
export const poolCandle = { type: 'object', properties: {
  intervalSeconds: { type: 'integer' }, bucketStart: { type: 'integer' },
  open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' },
  tradeCount: { type: 'integer' },
} } as const;
