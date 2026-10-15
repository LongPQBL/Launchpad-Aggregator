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
  statsComputedAt: { type: 'string', format: 'date-time', nullable: true },
  fdvUsd: { type: 'string', nullable: true }, marketCapUsd: { type: 'string', nullable: true }, priceUsd: { type: 'string', nullable: true },
  tvlUsd: { type: 'string', nullable: true }, tvlBasis: { type: 'string', nullable: true },
  tvlBlockNumber: { type: 'string', nullable: true }, tvlPriceSource: { type: 'string', nullable: true },
  tvlPriceUpdatedAt: { type: 'integer', nullable: true }, tvlUnavailableReason: { type: 'string', nullable: true },
  week52High: { type: 'string', nullable: true }, week52Low: { type: 'string', nullable: true },
  week52HighUsd: { type: 'string', nullable: true }, week52LowUsd: { type: 'string', nullable: true },
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
  // USD per 1 whole unit of the launch's quote asset (Chainlink feed), or null. Independent of
  // coverage: unlike priceUsd/FDV it needs no indexed trades.
  quotePriceUsd: { type: 'string', nullable: true },
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

export const globalTransaction = { type: 'object', properties: {
  source: { type: 'string', enum: ['official', 'pool'] },
  venueId: { type: 'string', nullable: true },
  pool: { type: 'object', nullable: true, properties: { protocol: { type: 'string' }, poolId: { type: 'string' } } },
  token: { type: 'object', properties: {
    chainId: { type: 'integer' }, tokenAddress: { type: 'string' }, name: { type: 'string', nullable: true },
    symbol: { type: 'string', nullable: true }, logoUri: { type: 'string', nullable: true },
  } },
  blockNumber: { type: 'string' }, txHash: { type: 'string' }, logIndex: { type: 'integer' },
  timestamp: { type: 'integer' }, side: { type: 'string' }, activityKind: { type: 'string', nullable: true },
  tokenAmount: { type: 'string', nullable: true }, quoteAmount: { type: 'string', nullable: true },
  quoteAsset: { type: 'object', properties: { address: { type: 'string' }, symbol: { type: 'string', nullable: true }, logoUri: { type: 'string', nullable: true } } },
  traderAddress: { type: 'string' },
  usdValue: { type: 'string', nullable: true }, usdValueApprox: { type: 'boolean' },
  usdValueStatus: { type: 'string', enum: ['priced', 'pending', 'unavailable'] },
} } as const;

export const candle = { type: 'object', properties: {
  intervalSeconds: { type: 'integer' }, bucketStart: { type: 'integer' },
  open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' },
  quoteVolume: { type: 'string' }, volumeUsd: { type: 'string' }, tradeCount: { type: 'integer' },
} } as const;

export function pageSchema(item: object) {
  return { type: 'object', properties: { items: { type: 'array', items: item }, nextCursor: { type: 'string', nullable: true } } } as const;
}

const nullableMetric = { type: 'string', nullable: true } as const;
const poolBalances = { type: 'object', nullable: true, properties: {
  displayedAmountRaw: { type: 'string' }, otherAmountRaw: { type: 'string' }, priceInQuote: { type: 'string' },
}, required: ['displayedAmountRaw', 'otherAmountRaw', 'priceInQuote'] } as const;
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
  poolBalances,
  launchTokenAddress: nullableMetric, volume24hUsd: nullableMetric, volume30dUsd: nullableMetric, volume24hChange: nullableMetric, priceInQuote: nullableMetric,
  priceUsd: nullableMetric, fdvUsd: nullableMetric, tvlUsd: nullableMetric, tvlChange: nullableMetric, change1h: nullableMetric,
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

export const searchResults = { type: 'object', properties: {
  tokens: { type: 'array', items: { type: 'object', properties: {
    chainId: { type: 'integer' }, tokenAddress: { type: 'string' }, name: { type: 'string', nullable: true },
    symbol: { type: 'string', nullable: true }, logoUri: { type: 'string', nullable: true }, platform: { type: 'string' },
    priceUsd: nullableMetric, change1d: nullableMetric,
  } } },
  pools: { type: 'array', items: { type: 'object', properties: {
    chainId: { type: 'integer' }, protocol: { type: 'string' }, poolId: { type: 'string' }, fee: { type: 'integer' }, hooks: { type: 'string', nullable: true },
    currency0: { type: 'string' }, currency1: { type: 'string' },
    currency0Symbol: nullableMetric, currency0LogoUri: nullableMetric,
    currency1Symbol: nullableMetric, currency1LogoUri: nullableMetric, volume24hUsd: nullableMetric,
    ponsDesignated: { type: 'boolean' },
    launchToken: { type: 'object', properties: {
      address: { type: 'string' }, name: { type: 'string', nullable: true },
      symbol: { type: 'string', nullable: true }, logoUri: { type: 'string', nullable: true },
    } },
  } } },
} } as const;

const depthRow = { type: 'object', properties: { price: { type: 'number' }, amount0: { type: 'number' }, total1: { type: 'number' }, cumulative1: { type: 'number' } } } as const;
const tokenSide = { type: 'object', properties: { address: { type: 'string' }, decimals: { type: 'integer', nullable: true } } } as const;
export const curveDepthResponse = { type: 'object', properties: {
  blockNumber: { type: 'string', nullable: true }, price: { type: 'number', nullable: true }, priceInverse: { type: 'number', nullable: true },
  feeBps: { type: 'integer', nullable: true }, creatorTaxBps: { type: 'integer', nullable: true },
  graduationThreshold: { type: 'string', nullable: true }, realQuoteReserve: { type: 'string', nullable: true },
  quoteReserve: { type: 'string', nullable: true }, tokenReserve: { type: 'string', nullable: true },
  quoteDecimals: { type: 'integer', nullable: true }, tokenDecimals: { type: 'integer', nullable: true }, tokenBalance: { type: 'string', nullable: true },
  asksEndAtGraduation: { type: 'boolean' }, bidsEndAtEmptyReserve: { type: 'boolean' },
  depth: { type: 'object', nullable: true, properties: { asks: { type: 'array', items: depthRow }, bids: { type: 'array', items: depthRow }, spreadPercent: { type: 'number', nullable: true } } },
  complete: { type: 'boolean' }, unavailableReason: { type: 'string', nullable: true },
} } as const;

export const poolLiquidity = { type: 'object', properties: {
  protocol: { type: 'string' }, blockNumber: { type: 'string', nullable: true }, tickSpacing: { type: 'integer' }, feePips: { type: 'integer' },
  currentTick: { type: 'integer', nullable: true }, price: { type: 'number', nullable: true }, priceInverse: { type: 'number', nullable: true },
  activeLiquidity: { type: 'string', nullable: true }, token0: tokenSide, token1: tokenSide,
  ranges: { type: 'array', items: { type: 'object', properties: { tickLower: { type: 'integer' }, tickUpper: { type: 'integer' }, priceLower: { type: 'number' },
    priceUpper: { type: 'number' }, liquidity: { type: 'string' }, active: { type: 'boolean' } } } },
  depth: { type: 'object', nullable: true, properties: { asks: { type: 'array', items: depthRow }, bids: { type: 'array', items: depthRow }, spreadPercent: { type: 'number', nullable: true } } },
  complete: { type: 'boolean' }, unavailableReason: { type: 'string', nullable: true },
} } as const;

export const poolHistory = { type: 'object', properties: {
  items: { type: 'array', items: { type: 'object', properties: {
    day: { type: 'integer' }, tradeCount: { type: 'integer' },
    volumeUsd: { type: 'string', nullable: true }, tvlUsd: { type: 'string', nullable: true },
  } } },
  complete: { type: 'boolean' },
  intervalSeconds: { type: 'integer' },
  // Launch history only: pools the answer is built from, and pools left out for lack of a USD price.
  poolCount: { type: 'integer' },
  unvaluedPools: { type: 'integer' },
} } as const;

export const curveSummary = { type: 'object', properties: {
  venueId: { type: 'string' }, curveAddress: { type: 'string' }, active: { type: 'boolean' },
  volume24hQuote: { type: 'string' }, tradeCount24h: { type: 'integer' },
  lastPriceQuote: { type: 'string', nullable: true },
} } as const;

export const walletPositions = { type: 'object', properties: {
  items: { type: 'array', items: { type: 'object', properties: {
    token: { type: 'object', properties: {
      chainId: { type: 'integer' }, tokenAddress: { type: 'string' }, name: { type: 'string', nullable: true },
      symbol: { type: 'string', nullable: true }, logoUri: { type: 'string', nullable: true }, decimals: { type: 'integer', nullable: true },
    } },
    tradeCount: { type: 'integer' }, buyCount: { type: 'integer' }, sellCount: { type: 'integer' },
    firstTradeAt: { type: 'integer' }, lastTradeAt: { type: 'integer' },
    quoteAsset: { type: 'object', properties: { address: { type: 'string' }, symbol: { type: 'string', nullable: true } } },
    quoteSpent: { type: 'string', nullable: true }, quoteReceived: { type: 'string', nullable: true },
    priceUsd: { type: 'string', nullable: true },
  } } },
} } as const;
